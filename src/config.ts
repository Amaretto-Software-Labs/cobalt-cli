import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { z } from "zod";
import { ConfigurationError } from "./errors.js";

const uuid = z.string().uuid();
const configSchema = z
  .strictObject({
    schemaVersion: z.literal(1),
    currentEnvironment: z.enum(["prod", "dev", "demo"]),
    environments: z
      .record(
        z.string(),
        z.strictObject({ workspaceId: uuid, workspaceName: z.string().min(1) }),
      )
      .default({}),
  })
  .superRefine((value, context) => {
    for (const key of Object.keys(value.environments)) {
      if (!["prod", "dev", "demo"].includes(key))
        context.addIssue({
          code: "custom",
          message: `Unknown environment '${key}'.`,
          path: ["environments", key],
        });
    }
  });

export type CliConfig = z.infer<typeof configSchema>;

export function defaultConfigPath(
  env: NodeJS.ProcessEnv = process.env,
  platform = process.platform,
): string {
  if (platform === "win32")
    return path.join(
      env.APPDATA ?? path.join(os.homedir(), "AppData", "Roaming"),
      "CobaltCode",
      "cli",
      "config.json",
    );
  if (platform === "darwin")
    return path.join(
      os.homedir(),
      "Library",
      "Application Support",
      "CobaltCode",
      "cli",
      "config.json",
    );
  return path.join(
    env.XDG_CONFIG_HOME ?? path.join(os.homedir(), ".config"),
    "cobalt",
    "config.json",
  );
}

export class ConfigStore {
  public constructor(public readonly filePath = defaultConfigPath()) {}

  public async load(): Promise<CliConfig> {
    try {
      const json = await fs.readFile(this.filePath, "utf8");
      return configSchema.parse(JSON.parse(json));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT")
        return {
          schemaVersion: 1,
          currentEnvironment: "prod",
          environments: {},
        };
      throw new ConfigurationError(
        `Cannot read CLI configuration at ${this.filePath}. Move the invalid file aside and retry.`,
        { cause: error },
      );
    }
  }

  public async save(config: CliConfig): Promise<void> {
    const value = configSchema.parse(config);
    const directory = path.dirname(this.filePath);
    const temporary = path.join(
      directory,
      `.${path.basename(this.filePath)}.${crypto.randomUUID()}.tmp`,
    );
    try {
      await fs.mkdir(directory, { recursive: true, mode: 0o700 });
      await fs.writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, {
        mode: 0o600,
        flag: "wx",
      });
      await fs.rename(temporary, this.filePath);
      if (process.platform !== "win32") await fs.chmod(this.filePath, 0o600);
    } catch (error) {
      throw new ConfigurationError(
        `Cannot write CLI configuration at ${this.filePath}.`,
        { cause: error },
      );
    } finally {
      await fs.rm(temporary, { force: true }).catch(() => undefined);
    }
  }
}
