import { addEnvironmentImageCommands } from "./environment-image-commands.js";
import { Command } from "commander";
import { validId } from "./api.js";
import { environmentDefinitionRequestSchema } from "./api-environment-schemas.js";
import { CliError, ExitCode, UsageError } from "./errors.js";
import type { Context } from "./runtime.js";

type MutationResult = { value: unknown; outcome?: string };
export interface EnvironmentCommandHelpers {
  execute(
    command: Command,
    scopes: string[],
    action: (context: Context) => Promise<void>,
  ): Promise<void>;
  mutationKey(command: Command): string;
  readDefinitionFile(path: string): Promise<string>;
}

export function addEnvironmentCommands(
  root: Command,
  task: Command,
  helpers: EnvironmentCommandHelpers,
): void {
  const read = ["cobaltcode.external.read"];
  const operate = ["cobaltcode.external.operate"];
  const environment = root
    .command("environment")
    .description("Manage workspace environments and persistent sidecars.");
  const generation = (command: Command) =>
    command.requiredOption(
      "--expected-generation <number>",
      "Current resource generation.",
      positiveGeneration,
    );
  const result = (
    command: Command,
    kind: string,
    action: (context: Context, key: string) => Promise<MutationResult>,
    scopes = operate,
  ) =>
    helpers.execute(command, scopes, async (context) => {
      const key = helpers.mutationKey(command);
      context.output.beginMutation(key);
      const value = await action(context, key);
      context.output.result(kind, value.value, key, value.outcome);
    });
  environment.command("list").action(async (_options, command) =>
    helpers.execute(command, read, async (context) => {
      context.output.result(
        "environment",
        await context.api.listEnvironments(context.requireWorkspace()),
      );
    }),
  );
  environment
    .command("get <environment-id>")
    .action(async (id: string, _options, command) =>
      helpers.execute(command, read, async (context) => {
        context.output.result(
          "environment",
          await context.api.getEnvironment(validId(id)),
        );
      }),
    );
  environment
    .command("operation <operation-id>")
    .option("--wait", "Poll this operation until it succeeds or terminates.")
    .option(
      "--timeout <seconds>",
      "Bounded wait deadline (1..3600 seconds).",
      waitTimeout,
      300,
    )
    .action(
      async (
        id: string,
        options: { wait?: boolean; timeout: number },
        command,
      ) =>
        helpers.execute(command, read, async (context) => {
          const operationId = validId(id);
          const deadline = Date.now() + options.timeout * 1000;
          const signal = options.wait
            ? AbortSignal.timeout(options.timeout * 1000)
            : undefined;
          let lastObservation: unknown;
          while (true) {
            const operation = await context.api
              .getEnvironmentOperation(operationId, signal)
              .catch((error: unknown) => {
                if (!signal?.aborted) throw error;
                if (lastObservation) {
                  context.output.result(
                    "environmentOperation",
                    lastObservation,
                  );
                  context.output.complete();
                }
                throw new CliError(
                  "Timed out waiting for the environment operation. Inspect the same operation ID to continue.",
                  ExitCode.unavailable,
                );
              });
            lastObservation = operation;
            if (!options.wait || operation.status === "succeeded") {
              context.output.result("environmentOperation", operation);
              return;
            }
            if (
              ["failed", "cancelled", "superseded"].includes(operation.status)
            ) {
              context.output.result("environmentOperation", operation);
              context.output.complete();
              throw new CliError(
                `Environment operation ended with status ${operation.status}.`,
                ExitCode.conflict,
              );
            }
            if (!["pending", "running"].includes(operation.status))
              throw new CliError(
                "The API returned an unknown environment operation status.",
                ExitCode.unavailable,
              );
            const remaining = deadline - Date.now();
            if (remaining <= 0) {
              context.output.result("environmentOperation", operation);
              context.output.complete();
              throw new CliError(
                "Timed out waiting for the environment operation. Inspect the same operation ID to continue.",
                ExitCode.unavailable,
              );
            }
            await new Promise((resolve) =>
              setTimeout(resolve, Math.min(1000, remaining)),
            );
          }
        }),
    );
  const definition = async (file: string) => {
    let value: unknown;
    try {
      value = JSON.parse(await helpers.readDefinitionFile(file));
    } catch (error) {
      if (error instanceof UsageError) throw error;
      throw new UsageError("Environment definition must contain valid JSON.");
    }
    const parsed = environmentDefinitionRequestSchema.safeParse(value);
    if (!parsed.success)
      throw new UsageError(
        "Environment definition does not match the public schema. Use secretReferences for secret UUIDs.",
      );
    return parsed.data;
  };
  environment
    .command("create")
    .requiredOption(
      "--definition-file <path>",
      "Complete environment JSON definition.",
    )
    .action(async (options: { definitionFile: string }, command) =>
      result(
        command,
        "environment",
        async (context, key) =>
          context.api.createEnvironment(
            context.requireWorkspace(),
            await definition(options.definitionFile),
            key,
          ),
        ["cobaltcode.external.create"],
      ),
    );
  generation(
    environment
      .command("update <environment-id>")
      .requiredOption(
        "--definition-file <path>",
        "Complete replacement JSON definition.",
      ),
  ).action(
    async (
      id: string,
      options: { definitionFile: string; expectedGeneration: number },
      command,
    ) =>
      result(command, "environment", async (context, key) =>
        context.api.updateEnvironment(
          validId(id),
          await definition(options.definitionFile),
          options.expectedGeneration,
          key,
        ),
      ),
  );
  for (const action of [
    "start",
    "stop",
    "restart",
    "delete",
    "revoke-service",
  ] as const) {
    generation(environment.command(`${action} <environment-id>`)).action(
      async (id: string, options: { expectedGeneration: number }, command) =>
        result(command, "environmentOperation", async (context, key) =>
          context.api.environmentAction(
            validId(id),
            action.replace("-", "_"),
            options.expectedGeneration,
            key,
          ),
        ),
    );
  }
  const sidecar = environment
    .command("sidecar")
    .description("Manage one sidecar using its environment generation.");
  addEnvironmentImageCommands(environment, sidecar, helpers);
  sidecar
    .command("diagnostics <environment-id> <sidecar-id>")
    .description(
      "Read bounded sanitized logs and the last readiness probe without waking compute.",
    )
    .action(async (id: string, sidecarId: string, _options, command) =>
      helpers.execute(command, read, async (context) => {
        context.output.result(
          "sidecarDiagnostics",
          await context.api.sidecarDiagnostics(validId(id), validId(sidecarId)),
        );
      }),
    );
  for (const action of ["restart", "delete"] as const) {
    generation(
      sidecar.command(`${action} <environment-id> <sidecar-id>`),
    ).action(
      async (
        id: string,
        sidecarId: string,
        options: { expectedGeneration: number },
        command,
      ) =>
        result(command, "environmentOperation", async (context, key) =>
          context.api.sidecarAction(
            validId(id),
            validId(sidecarId),
            action,
            options.expectedGeneration,
            key,
          ),
        ),
    );
  }
  const attachments = task
    .command("environment")
    .description("Manage durable task attachments and explicit default DNS.");
  attachments
    .command("list <task-id>")
    .action(async (id: string, _options, command) =>
      helpers.execute(command, read, async (context) => {
        context.output.result(
          "taskEnvironmentAttachments",
          await context.api.listTaskEnvironmentAttachments(validId(id)),
        );
      }),
    );
  attachments
    .command("attach <task-id> <environment-id>")
    .option(
      "--bindings-file <path>",
      "JSON map of application variable names to connection templates.",
    )
    .action(
      async (
        id: string,
        environmentId: string,
        options: { bindingsFile?: string },
        command,
      ) =>
        result(command, "taskEnvironmentAttachment", async (context, key) => {
          let bindings: Record<string, string> | undefined;
          if (options.bindingsFile) {
            let value: unknown;
            try {
              value = JSON.parse(
                await helpers.readDefinitionFile(options.bindingsFile),
              );
            } catch (error) {
              if (error instanceof UsageError) throw error;
              throw new UsageError(
                "Connection bindings must contain valid JSON.",
              );
            }
            if (
              !value ||
              typeof value !== "object" ||
              Array.isArray(value) ||
              Object.values(value).some((item) => typeof item !== "string")
            )
              throw new UsageError(
                "Connection bindings must be a JSON object containing string values.",
              );
            bindings = value as Record<string, string>;
            if (
              Object.entries(bindings).some(
                ([name, label]) =>
                  !/^[A-Za-z_][A-Za-z0-9_]{0,127}$/.test(name) ||
                  !/^[a-z](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label),
              )
            )
              throw new UsageError(
                "Connection bindings map application variable names to plain sidecar DNS labels such as db.",
              );
          }
          return context.api.attachTaskEnvironment(
            validId(id),
            validId(environmentId),
            bindings,
            key,
          );
        }),
    );
  generation(attachments.command("detach <task-id> <attachment-id>")).action(
    async (
      id: string,
      attachmentId: string,
      options: { expectedGeneration: number },
      command,
    ) =>
      result(command, "taskEnvironmentAttachment", async (context, key) =>
        context.api.detachTaskEnvironment(
          validId(id),
          validId(attachmentId),
          options.expectedGeneration,
          key,
        ),
      ),
  );
  generation(
    attachments
      .command("dns-default <task-id>")
      .option("--attachment <uuid>", "Explicit DNS attachment UUID.")
      .option("--clear", "Clear the task's DNS default."),
  ).action(
    async (
      id: string,
      options: {
        expectedGeneration: number;
        attachment?: string;
        clear?: boolean;
      },
      command,
    ) =>
      result(command, "taskEnvironmentAttachments", async (context, key) => {
        if (Boolean(options.attachment) === Boolean(options.clear))
          throw new UsageError(
            "Supply exactly one of --attachment or --clear.",
          );
        return context.api.setTaskEnvironmentDnsDefault(
          validId(id),
          options.attachment ? validId(options.attachment) : null,
          options.expectedGeneration,
          key,
        );
      }),
  );
}

export function positiveGeneration(value: string): number {
  if (!/^[1-9]\d*$/.test(value) || !Number.isSafeInteger(Number(value)))
    throw new UsageError(
      "Expected generation must be a positive safe integer.",
    );
  return Number(value);
}

function waitTimeout(value: string): number {
  const seconds = positiveGeneration(value);
  if (seconds > 3600)
    throw new UsageError("--timeout must be between 1 and 3600 seconds.");
  return seconds;
}
