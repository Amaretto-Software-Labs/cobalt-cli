import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ConfigStore } from "./config.js";
import { ConfigurationError } from "./errors.js";

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(
    directories
      .splice(0)
      .map((directory) => fs.rm(directory, { recursive: true, force: true })),
  );
});

describe("ConfigStore", () => {
  it("writes and reads a private atomic configuration", async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "cobalt-cli-"));
    directories.push(directory);
    const file = path.join(directory, "nested", "config.json");
    const store = new ConfigStore(file);
    await store.save({
      schemaVersion: 1,
      currentEnvironment: "dev",
      environments: {
        dev: {
          workspaceId: "11111111-1111-4111-8111-111111111111",
          workspaceName: "Engineering",
        },
      },
    });
    await expect(store.load()).resolves.toMatchObject({
      currentEnvironment: "dev",
    });
    if (process.platform !== "win32")
      expect((await fs.stat(file)).mode & 0o777).toBe(0o600);
  });

  it("fails closed on an invalid configuration", async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "cobalt-cli-"));
    directories.push(directory);
    const file = path.join(directory, "config.json");
    await fs.writeFile(file, "{}");
    await expect(new ConfigStore(file).load()).rejects.toBeInstanceOf(
      ConfigurationError,
    );
  });
});
