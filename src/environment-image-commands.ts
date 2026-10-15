import { Command } from "commander";
import { validId } from "./api.js";
import type { EnvironmentCommandHelpers } from "./environment-commands.js";
import { positiveGeneration } from "./environment-commands.js";

type SourceOptions = {
  name: string;
  registry: string;
  username: string;
  credentialEntry: string;
  expectedGeneration: number;
};

export function addEnvironmentImageCommands(
  environment: Command,
  sidecar: Command,
  helpers: EnvironmentCommandHelpers,
): void {
  const read = ["cobaltcode.external.read"];
  const operate = ["cobaltcode.external.operate"];
  const sources = environment
    .command("image-source")
    .description(
      "Manage workspace registries using existing Vault credentials.",
    );
  sources.command("list").action(async (_options, command) =>
    helpers.execute(command, read, async (context) => {
      context.output.result(
        "environmentImageSource",
        await context.api.listEnvironmentImageSources(
          context.requireWorkspace(),
        ),
      );
    }),
  );
  sources
    .command("repositories <source-id>")
    .option("--cursor <cursor>", "Continue from the previous page cursor.")
    .action(async (sourceId: string, options: { cursor?: string }, command) =>
      helpers.execute(command, read, async (context) => {
        context.output.result(
          "environmentImageRepositories",
          await context.api.listEnvironmentImageRepositories(
            validId(sourceId),
            options.cursor,
          ),
        );
      }),
    );
  sources
    .command("tags <source-id> <repository>")
    .option("--cursor <cursor>", "Continue from the previous page cursor.")
    .action(
      async (
        sourceId: string,
        repository: string,
        options: { cursor?: string },
        command,
      ) =>
        helpers.execute(command, read, async (context) => {
          context.output.result(
            "environmentImageTags",
            await context.api.listEnvironmentImageTags(
              validId(sourceId),
              repository,
              options.cursor,
            ),
          );
        }),
    );
  const fields = (command: Command) =>
    command
      .requiredOption("--name <name>", "Source display name.")
      .requiredOption(
        "--registry <host>",
        "Registry host, for example ghcr.io.",
      )
      .requiredOption("--username <username>", "Registry account username.")
      .requiredOption(
        "--credential-entry <entry-id>",
        "Existing workspace Vault secret entry ID.",
      );
  const payload = (options: SourceOptions) => ({
    name: options.name,
    registryHost: options.registry,
    username: options.username,
    credentialEntryId: validId(options.credentialEntry),
  });
  fields(sources.command("create")).action(
    async (options: SourceOptions, command) =>
      helpers.execute(
        command,
        ["cobaltcode.external.create"],
        async (context) => {
          const key = helpers.mutationKey(command);
          context.output.beginMutation(key);
          const result = await context.api.createEnvironmentImageSource(
            context.requireWorkspace(),
            payload(options),
            key,
          );
          context.output.result(
            "environmentImageSource",
            result.value,
            key,
            result.outcome,
          );
        },
      ),
  );
  fields(sources.command("update <source-id>"))
    .requiredOption(
      "--expected-generation <number>",
      "Current source generation.",
      positiveGeneration,
    )
    .action(async (sourceId: string, options: SourceOptions, command) =>
      helpers.execute(command, operate, async (context) => {
        const key = helpers.mutationKey(command);
        context.output.beginMutation(key);
        const result = await context.api.updateEnvironmentImageSource(
          validId(sourceId),
          payload(options),
          options.expectedGeneration,
          key,
        );
        context.output.result(
          "environmentImageSource",
          result.value,
          key,
          result.outcome,
        );
      }),
    );
  sources
    .command("delete <source-id>")
    .requiredOption(
      "--expected-generation <number>",
      "Current source generation.",
      positiveGeneration,
    )
    .action(
      async (
        sourceId: string,
        options: { expectedGeneration: number },
        command,
      ) =>
        helpers.execute(command, operate, async (context) => {
          const key = helpers.mutationKey(command);
          context.output.beginMutation(key);
          const result = await context.api.deleteEnvironmentImageSource(
            validId(sourceId),
            options.expectedGeneration,
            key,
          );
          context.output.result(
            "environmentImageSource",
            result.value,
            key,
            result.outcome,
          );
        }),
    );
  sidecar
    .command("retry-image <environment-id> <sidecar-id>")
    .requiredOption(
      "--expected-generation <number>",
      "Current environment generation.",
      positiveGeneration,
    )
    .action(
      async (
        id: string,
        sidecarId: string,
        options: { expectedGeneration: number },
        command,
      ) =>
        helpers.execute(command, operate, async (context) => {
          const key = helpers.mutationKey(command);
          context.output.beginMutation(key);
          const result = await context.api.retrySidecarImage(
            validId(id),
            validId(sidecarId),
            options.expectedGeneration,
            key,
          );
          context.output.result(
            "environment",
            result.value,
            key,
            result.outcome,
          );
        }),
    );
}
