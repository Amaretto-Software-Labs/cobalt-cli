import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { ConfigurationError } from "./errors.js";

const defaultWaitTimeoutMs = 35_000;

export async function withCredentialRefreshLock<T>(
  account: string,
  signal: AbortSignal | undefined,
  action: () => Promise<T>,
  lockRoot = path.join(os.tmpdir(), "cobalt-cli-refresh-locks"),
): Promise<T> {
  await fs.mkdir(lockRoot, { recursive: true, mode: 0o700 });
  const lockName = crypto.createHash("sha256").update(account).digest("hex");
  const lockPath = path.join(lockRoot, `${lockName}.lock`);
  const deadline = Date.now() + defaultWaitTimeoutMs;

  while (true) {
    signal?.throwIfAborted();
    try {
      await fs.writeFile(lockPath, `${process.pid}\n`, {
        encoding: "utf8",
        flag: "wx",
        mode: 0o600,
      });
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST")
        throw new ConfigurationError(
          "Cannot coordinate the Cobalt CLI OAuth session refresh.",
          { cause: error },
        );
      if (await removeAbandonedLock(lockPath)) continue;
      if (Date.now() >= deadline)
        throw new ConfigurationError(
          "Another Cobalt CLI process is still refreshing authentication. Retry shortly.",
        );
      await delay(100, undefined, { signal });
    }
  }

  try {
    return await action();
  } finally {
    await fs.unlink(lockPath).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== "ENOENT") throw error;
    });
  }
}

async function removeAbandonedLock(lockPath: string): Promise<boolean> {
  let owner: string;
  try {
    owner = await fs.readFile(lockPath, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return true;
    return false;
  }

  const processId = Number.parseInt(owner.trim(), 10);
  if (!Number.isSafeInteger(processId) || processId <= 0) return false;
  try {
    process.kill(processId, 0);
    return false;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ESRCH") return false;
  }
  try {
    await fs.unlink(lockPath);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ENOENT";
  }
}
