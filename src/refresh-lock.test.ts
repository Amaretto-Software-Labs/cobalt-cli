import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { withCredentialRefreshLock } from "./refresh-lock.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map(async (directory) => {
      await fs.rm(directory, { recursive: true, force: true });
    }),
  );
});

describe("OAuth refresh coordination", () => {
  it("serializes refreshes for the same saved account", async () => {
    const lockRoot = await createTemporaryDirectory();
    let active = 0;
    let maximumActive = 0;
    const completed: number[] = [];
    const refresh = async (id: number) =>
      await withCredentialRefreshLock(
        "dev:cobalt-cli-dev:api-dev.cobaltcode.ai",
        undefined,
        async () => {
          active += 1;
          maximumActive = Math.max(maximumActive, active);
          await new Promise((resolve) => setTimeout(resolve, 25));
          completed.push(id);
          active -= 1;
          return id;
        },
        lockRoot,
      );

    await expect(Promise.all([refresh(1), refresh(2)])).resolves.toEqual([
      1, 2,
    ]);
    expect(maximumActive).toBe(1);
    expect(completed.toSorted()).toEqual([1, 2]);
  });

  it("reclaims a lock whose owner process no longer exists", async () => {
    const lockRoot = await createTemporaryDirectory();
    const account = "dev:cobalt-cli-dev:api-dev.cobaltcode.ai";
    const lockName = crypto.createHash("sha256").update(account).digest("hex");
    await fs.writeFile(path.join(lockRoot, `${lockName}.lock`), "2147483647\n");

    await expect(
      withCredentialRefreshLock(
        account,
        undefined,
        async () => "refreshed",
        lockRoot,
      ),
    ).resolves.toBe("refreshed");
  });
});

async function createTemporaryDirectory(): Promise<string> {
  const directory = await fs.mkdtemp(
    path.join(os.tmpdir(), "cobalt-cli-refresh-lock-test-"),
  );
  temporaryDirectories.push(directory);
  return directory;
}
