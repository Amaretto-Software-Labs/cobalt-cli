import fs from "node:fs/promises";
import { setTimeout as sleep } from "node:timers/promises";
import { Command, CommanderError, Option } from "commander";
import { validId } from "./api.js";
import { environments, resolveEnvironment } from "./environment.js";
import { authStatus, login, logout, openBrowser } from "./auth.js";
import { CliError, ExitCode, UsageError } from "./errors.js";
import { readAvailableEvents } from "./events.js";
import { Output } from "./output.js";
import {
  Runtime,
  allPages,
  resolveAgent,
  resolveRepositoryItem,
  resolveWorkspaceItem,
  type Context,
  type GlobalOptions,
  type PageLike,
} from "./runtime.js";
import { runInteractive } from "./interactive.js";
import { isTerminalTaskStatus } from "./task-status.js";
import { packageVersion } from "./version.js";

const readScopes = ["cobaltcode.external.read"];
const operateScopes = ["cobaltcode.external.operate"];
const createScopes = ["cobaltcode.external.create"];
const maximumTimerMilliseconds = 2_147_483_647;
type CommandAction = (context: Context) => Promise<void>;

export function createProgram(runtime: Runtime): Command {
  const root = new Command("cobalt")
    .description("Operate Cobalt tasks through the Cobalt External API.")
    .version(packageVersion(), "-V, --version")
    .showHelpAfterError()
    .exitOverride()
    .option(
      "--environment <environment>",
      "Environment: prod, dev, demo, or local.",
    )
    .option("--workspace <workspace>", "Workspace UUID or exact name.")
    .option("--json", "Emit one JSON document.")
    .option("--jsonl", "Emit JSON Lines.")
    .option("--quiet", "Suppress non-result human progress and warnings.")
    .option("--no-color", "Disable color.")
    .option("--trace", "Emit safe request diagnostics.")
    .option("--idempotency-key <uuid>", "Mutation idempotency UUID.");

  const auth = root.command("auth").description("Authenticate the CLI.");
  auth
    .command("login")
    .description("Sign in using browser OAuth.")
    .option("--no-open")
    .option("--read-only")
    .action(async (_options, command) => {
      await execute(runtime, command, [], false, async (context) => {
        const options = command.opts() as { open: boolean; readOnly?: boolean };
        await login(
          context.environment,
          context.credentialStore,
          Boolean(options.readOnly),
          options.open,
        );
        context.config.currentEnvironment = context.environment.name;
        await context.configStore.save(context.config);
        context.output.result("auth", {
          authenticated: true,
          environment: context.environment.name,
        });
      });
    });
  auth
    .command("logout")
    .description("Remove the saved session.")
    .option("--all-environments")
    .action(async (options: { allEnvironments?: boolean }, command) => {
      await execute(runtime, command, [], false, async (context) => {
        if (options.allEnvironments) {
          const results = [];
          for (const environment of environments)
            results.push({
              environment: environment.name,
              authenticated: false,
              revocationConfirmed: await logout(
                environment,
                context.credentialStore,
              ),
            });
          context.output.result("auth", results);
        } else
          context.output.result("auth", {
            authenticated: false,
            environment: context.environment.name,
            revocationConfirmed: await logout(
              context.environment,
              context.credentialStore,
            ),
          });
      });
    });
  auth
    .command("status")
    .description("Show authentication status.")
    .action(async (_options, command) =>
      execute(runtime, command, [], false, async (context) =>
        context.output.result(
          "auth",
          await authStatus(context.environment, context.credentialStore),
        ),
      ),
    );

  const workspace = root
    .command("workspace")
    .description("List and select workspaces.");
  workspace
    .command("list")
    .option("--all")
    .addOption(limitOption(100))
    .action(async (options: PageOptions, command) =>
      execute(runtime, command, readScopes, true, async (context) =>
        page(context, "workspace", options, (cursor) =>
          context.api.listWorkspaces(options.limit, cursor),
        ),
      ),
    );
  workspace
    .command("use <workspace>")
    .action(async (reference: string, _options, command) =>
      execute(runtime, command, readScopes, true, async (context) => {
        const item = await resolveWorkspaceItem(context.api, reference);
        context.config.currentEnvironment = context.environment.name;
        context.config.environments[context.environment.name] = {
          workspaceId: item.id,
          workspaceName: item.name,
        };
        await context.configStore.save(context.config);
        context.output.result("workspace", item);
      }),
    );
  workspace.command("current").action(async (_options, command) =>
    execute(runtime, command, [], true, async (context) => {
      context.output.result(
        "workspaceContext",
        context.workspaceId
          ? {
              workspaceId: context.workspaceId,
              workspaceName: context.workspaceName ?? null,
              verifiedAt: null,
            }
          : null,
      );
    }),
  );

  const repo = root.command("repo").description("Discover task repositories.");
  repo
    .command("list")
    .option("--all")
    .option("--eligible-only")
    .addOption(limitOption(100))
    .action(
      async (options: PageOptions & { eligibleOnly?: boolean }, command) =>
        execute(runtime, command, readScopes, true, async (context) =>
          page(context, "repository", options, async (cursor) => {
            const result = await context.api.listRepositories(
              context.requireWorkspace(),
              options.limit,
              cursor,
            );
            return {
              ...result,
              items: options.eligibleOnly
                ? result.items.filter((item) => item.taskEligible)
                : result.items,
            };
          }),
        ),
    );

  const agent = root
    .command("agent")
    .description("Discover coding-agent accounts.");
  agent
    .command("list")
    .option("--all")
    .option("--available")
    .addOption(limitOption(100))
    .action(async (options: PageOptions & { available?: boolean }, command) =>
      execute(runtime, command, readScopes, true, async (context) =>
        page(context, "agentAccount", options, async (cursor) => {
          const result = await context.api.listAgents(
            context.workspaceId,
            options.limit,
            cursor,
          );
          return {
            ...result,
            items: options.available
              ? result.items.filter((item) => item.status === "ready")
              : result.items,
          };
        }),
      ),
    );

  const task = root
    .command("task")
    .description("Read and operate Cobalt tasks.");
  task
    .command("list")
    .option("--status <status...>")
    .option("--repo <repository>")
    .option("--created-by-me")
    .option("--all")
    .addOption(limitOption(100))
    .action(
      async (
        options: PageOptions & {
          status?: string[];
          repo?: string;
          createdByMe?: boolean;
        },
        command,
      ) =>
        execute(runtime, command, readScopes, true, async (context) => {
          if ((options.status?.length ?? 0) > 25)
            throw new UsageError("--status may be repeated at most 25 times.");
          if (options.status?.some((value) => !value.trim()))
            throw new UsageError("--status values must not be empty.");
          const repositoryId = options.repo
            ? (
                await resolveRepositoryItem(
                  context.api,
                  context.requireWorkspace(),
                  options.repo,
                )
              ).id
            : undefined;
          await page(context, "task", options, (cursor) =>
            context.api.listTasks(context.requireWorkspace(), {
              ...(options.status ? { status: options.status } : {}),
              ...(repositoryId ? { repositoryId } : {}),
              ...(options.createdByMe ? { createdByMe: true } : {}),
              limit: options.limit,
              ...(cursor ? { cursor } : {}),
            }),
          );
        }),
    );
  task
    .command("get <task-id>")
    .action(async (taskId: string, _options, command) =>
      execute(runtime, command, readScopes, true, async (context) =>
        context.output.result("task", await context.api.getTask(taskId)),
      ),
    );
  task
    .command("search <query>")
    .option("--all")
    .addOption(limitOption(50))
    .action(async (query: string, options: PageOptions, command) =>
      execute(runtime, command, readScopes, true, async (context) => {
        validateSearch(query);
        await page(context, "taskSearchResult", options, (cursor) =>
          context.api.searchTasks(context.requireWorkspace(), {
            query,
            limit: options.limit,
            ...(cursor ? { cursor } : {}),
          }),
        );
      }),
    );
  task
    .command("messages <task-id>")
    .option("--all")
    .addOption(limitOption(100))
    .action(async (taskId: string, options: PageOptions, command) =>
      execute(runtime, command, readScopes, true, async (context) =>
        page(context, "taskMessage", options, (cursor) =>
          context.api.listMessages(taskId, options.limit, cursor),
        ),
      ),
    );
  task
    .command("message-search <query>")
    .option("--task <uuid>")
    .option("--all")
    .addOption(limitOption(50))
    .action(
      async (
        query: string,
        options: PageOptions & { task?: string },
        command,
      ) =>
        execute(runtime, command, readScopes, true, async (context) => {
          validateSearch(query);
          await page(context, "messageSearchResult", options, (cursor) =>
            context.api.searchMessages(context.requireWorkspace(), {
              query,
              ...(options.task ? { taskId: validId(options.task) } : {}),
              limit: options.limit,
              ...(cursor ? { cursor } : {}),
            }),
          );
        }),
    );
  task
    .command("events <task-id>")
    .option("--after-sequence <sequence>", "Sequence", parseNonNegative, 0)
    .option("--all")
    .addOption(limitOption(100))
    .action(
      async (
        taskId: string,
        options: PageOptions & { afterSequence: number },
        command,
      ) =>
        execute(runtime, command, readScopes, true, async (context) => {
          let sequence = options.afterSequence;
          do {
            const page = await context.api.listEvents(
              taskId,
              sequence,
              options.limit,
            );
            context.output.result("taskEvent", page.items);
            const prior = sequence;
            if (page.items.length) sequence = page.items.at(-1)!.sequence;
            if (page.hasMore && sequence <= prior)
              throw new CliError(
                "The External API returned an event page without advancing its sequence.",
                ExitCode.unavailable,
              );
            if (!options.all || !page.hasMore) {
              if (context.output.mode === "jsonl")
                context.output.pageEnd(page.hasMore);
              break;
            }
          } while (true);
        }),
    );

  addTaskCreate(task, runtime);
  addProcessCommands(root, runtime);
  const queue = task
    .command("queue")
    .description("Inspect or manage task admission.");
  queue
    .command("list")
    .option("--all")
    .action(async (options: PageOptions, command) =>
      execute(runtime, command, readScopes, true, async (context) =>
        page(context, "taskAdmission", options, (cursor) =>
          context.api.listTaskQueue(context.requireWorkspace(), cursor),
        ),
      ),
    );
  for (const action of [
    "hold",
    "release",
    "cancel",
    "retry",
    "move",
  ] as const) {
    const cmd = queue
      .command(`${action} <task-id>`)
      .requiredOption("--admission-id <uuid>")
      .requiredOption(
        "--version <number>",
        "Current admission version.",
        parsePositive,
      );
    if (action === "move")
      cmd
        .addOption(
          new Option("--direction <direction>").choices(["earlier", "later"]),
        )
        .option("--before-entry <uuid>");
    cmd.action(
      async (
        taskId: string,
        options: {
          admissionId: string;
          version: number;
          direction?: string;
          beforeEntry?: string;
        },
        command,
      ) =>
        mutation(
          runtime,
          command,
          (context, key) => {
            if (
              action === "move" &&
              Boolean(options.direction) === Boolean(options.beforeEntry)
            )
              throw new UsageError(
                "For move, supply exactly one of --direction or --before-entry.",
              );
            return context.api.mutateTaskAdmission(
              taskId,
              action,
              {
                admissionId: validId(options.admissionId),
                version: options.version,
                ...(options.direction ? { direction: options.direction } : {}),
                ...(options.beforeEntry
                  ? { beforeEntryId: validId(options.beforeEntry) }
                  : {}),
              },
              key,
            );
          },
          "taskAdmission",
        ),
    );
  }

  task
    .command("auto-wake <task-id> <state>")
    .description("Set saved resume restoration: on or off.")
    .action(async (taskId: string, state: string, _options, command) => {
      if (!["on", "off"].includes(state))
        throw new UsageError("State must be on or off.");
      await mutation(
        runtime,
        command,
        (context, key) =>
          context.api.setTaskAutoWake(taskId, state === "on", key),
        "taskAutoWake",
      );
    });
  addMessageMutation(
    task,
    runtime,
    "send",
    async (context, taskId, options, key) =>
      context.api.sendMessage(
        taskId,
        {
          message: await readMessage(options),
          ...(options.role ? { roleKey: options.role } : {}),
          ...(hasAgentSelection(options)
            ? {
                agent: await resolveAgent(
                  context.api,
                  context.requireWorkspace(),
                  options.agent,
                  options.model,
                  options.reasoning,
                ),
              }
            : {}),
        },
        key,
      ),
    "messageAccepted",
  );
  task
    .command("steer <task-id> <message-id>")
    .action(async (taskId: string, messageId: string, _options, command) =>
      mutation(
        runtime,
        command,
        (context, key) => context.api.steerMessage(taskId, messageId, key),
        "messageSteered",
      ),
    );
  task
    .command("cancel <task-id>")
    .description("Cancel the active turn.")
    .action(async (taskId: string, _options, command) =>
      mutation(
        runtime,
        command,
        (context, key) => context.api.cancelTurn(taskId, key),
        "taskOperationAccepted",
        "Cancellation is accepted asynchronously; partial file, Git, or provider changes may remain.",
      ),
    );
  task
    .command("suspend <task-id>")
    .action(async (taskId: string, _options, command) =>
      mutation(
        runtime,
        command,
        (context, key) => context.api.suspendTask(taskId, key),
        "taskOperationAccepted",
      ),
    );
  task
    .command("resume <task-id>")
    .option("--agent <agent>")
    .option("--model <model>")
    .option("--reasoning <effort>")
    .action(async (taskId: string, options: AgentOptions, command) =>
      mutation(
        runtime,
        command,
        async (context, key) =>
          context.api.resumeTask(
            taskId,
            hasAgentSelection(options)
              ? {
                  agent: await resolveAgent(
                    context.api,
                    context.requireWorkspace(),
                    options.agent,
                    options.model,
                    options.reasoning,
                  ),
                }
              : {},
            key,
          ),
        "taskOperationAccepted",
      ),
    );
  task
    .command("delete <task-id>")
    .description("Delete the task, its computer, and its writable disk.")
    .action(async (taskId: string, _options, command) =>
      mutation(
        runtime,
        command,
        (context, key) => context.api.deleteTask(taskId, key),
        "taskOperationAccepted",
      ),
    );
  addWait(task, runtime);
  addFollow(task, runtime);
  task
    .command("open <task-id>")
    .action(async (taskId: string, _options, command) =>
      execute(runtime, command, readScopes, true, async (context) => {
        await context.api.getTask(taskId);
        const target = new URL(
          `/chats/${taskId}`,
          context.environment.webFrontend,
        );
        await openBrowser(target.toString());
        context.output.result("open", target.toString());
      }),
    );

  root
    .command("interactive")
    .option("--task <uuid>")
    .action(async (options: { task?: string }, command) =>
      execute(runtime, command, readScopes, true, async (context) => {
        const global = globalOptions(command);
        if (
          global.json ||
          global.jsonl ||
          global.quiet ||
          global.idempotencyKey
        )
          throw new UsageError(
            "interactive does not support structured, quiet, or idempotency options.",
          );
        await runInteractive(runtime, context, options.task);
      }),
    );
  root.command("completion <shell>").action((shell: string) => {
    const script = completion(shell.toLowerCase());
    if (!script)
      throw new UsageError(
        "Shell must be one of: bash, zsh, fish, powershell.",
      );
    process.stdout.write(`${script}\n`);
  });
  root.command("version").action(() => {
    process.stdout.write(`${packageVersion()}\n`);
  });
  return root;
}

function addProcessCommands(root: Command, runtime: Runtime): void {
  const loop = root
    .command("loop")
    .description("Inspect and manage workspace Loops.");
  loop
    .command("list")
    .addOption(
      new Option("--view <view>")
        .choices(["mine", "workspace"])
        .default("mine"),
    )
    .option("--all")
    .addOption(limitOption(100))
    .action(async (options: PageOptions & { view: string }, command) =>
      execute(runtime, command, readScopes, true, async (context) =>
        page(context, "loop", options, (cursor) =>
          context.api.listLoops(
            context.requireWorkspace(),
            options.view,
            options.limit,
            cursor,
          ),
        ),
      ),
    );
  loop
    .command("get <loop-id>")
    .action(async (id: string, _options, command) =>
      execute(runtime, command, readScopes, true, async (context) =>
        context.output.result(
          "loop",
          await context.api.getLoop(context.requireWorkspace(), id),
        ),
      ),
    );
  for (const action of ["create", "update"] as const) {
    const cmd = loop
      .command(action === "create" ? "create" : "update <loop-id>")
      .requiredOption(
        "--document-file <path>",
        "Complete canonical Loop document.",
      );
    if (action === "update")
      cmd.requiredOption(
        "--expected-version <number>",
        "Version read by loop get.",
        parsePositive,
      );
    cmd.action(async (...args: unknown[]) => {
      const command = args.at(-1) as Command;
      const options = command.opts() as {
        documentFile: string;
        expectedVersion: number;
      };
      await execute(
        runtime,
        command,
        action === "create" ? createScopes : operateScopes,
        true,
        async (context) => {
          const document = await readDefinitionFile(options.documentFile);
          const key = mutationKey(command);
          context.output.beginMutation(key);
          const result =
            action === "create"
              ? await context.api.createLoop(
                  context.requireWorkspace(),
                  document,
                  key,
                )
              : await context.api.updateLoop(
                  context.requireWorkspace(),
                  args[0] as string,
                  document,
                  options.expectedVersion,
                  key,
                );
          context.output.result("loop", result.value, key, result.outcome);
        },
      );
    });
  }
  loop
    .command("enable <loop-id>")
    .description(
      "Authorize future runs as your identity and enable this exact version.",
    )
    .requiredOption(
      "--expected-version <number>",
      "Version read by loop get.",
      parsePositive,
    )
    .action(async (id: string, options: { expectedVersion: number }, command) =>
      mutation(
        runtime,
        command,
        (context, key) =>
          context.api.enableLoop(
            context.requireWorkspace(),
            id,
            options.expectedVersion,
            key,
          ),
        "loop",
      ),
    );
  for (const action of ["disable", "delete"] as const)
    loop
      .command(`${action} <loop-id>`)
      .action(async (id: string, _options, command) =>
        mutation(
          runtime,
          command,
          (context, key) =>
            action === "disable"
              ? context.api.disableLoop(context.requireWorkspace(), id, key)
              : context.api.deleteLoop(context.requireWorkspace(), id, key),
          "loop",
        ),
      );
  loop
    .command("run <loop-id>")
    .option("--test")
    .option("--force-fresh-task")
    .option("--subject-kind <kind>")
    .option("--subject-id <id>")
    .option("--subject-locator <locator>")
    .action(
      async (
        id: string,
        options: {
          test?: boolean;
          forceFreshTask?: boolean;
          subjectKind?: string;
          subjectId?: string;
          subjectLocator?: string;
        },
        command,
      ) =>
        execute(runtime, command, createScopes, true, async (context) => {
          if (
            Boolean(options.subjectKind) !== Boolean(options.subjectId) ||
            (options.subjectLocator && !options.subjectId)
          )
            throw new UsageError(
              "Supply --subject-kind and --subject-id together.",
            );
          const key = mutationKey(command);
          context.output.beginMutation(key);
          const result = await context.api.runLoop(
            context.requireWorkspace(),
            id,
            {
              test: Boolean(options.test),
              forceFreshTask: Boolean(options.forceFreshTask),
              ...(options.subjectId
                ? {
                    subject: {
                      kind: options.subjectKind,
                      externalId: options.subjectId,
                      locator: options.subjectLocator ?? null,
                    },
                  }
                : {}),
            },
            key,
          );
          context.output.result("loopRun", result.value, key, result.outcome);
        }),
    );
  loop
    .command("rerun <loop-id> <run-id>")
    .addOption(
      new Option("--mode <mode>")
        .choices(["same_inputs", "current_definition"])
        .makeOptionMandatory(),
    )
    .action(
      async (id: string, runId: string, options: { mode: string }, command) =>
        execute(runtime, command, createScopes, true, async (context) => {
          const key = mutationKey(command);
          context.output.beginMutation(key);
          const result = await context.api.rerunLoop(
            context.requireWorkspace(),
            id,
            runId,
            options.mode,
            key,
          );
          context.output.result("loopRun", result.value, key, result.outcome);
        }),
    );
  for (const action of ["runs", "decisions", "lanes"] as const)
    loop
      .command(`${action} <loop-id>`)
      .option("--all")
      .addOption(limitOption(100))
      .action(async (id: string, options: PageOptions, command) =>
        execute(runtime, command, readScopes, true, async (context) => {
          const workspace = context.requireWorkspace();
          if (action === "runs")
            await page(context, "loopRun", options, (cursor) =>
              context.api.listLoopRuns(workspace, id, options.limit, cursor),
            );
          else if (action === "decisions")
            await page(context, "loopDecision", options, (cursor) =>
              context.api.listLoopDecisions(
                workspace,
                id,
                options.limit,
                cursor,
              ),
            );
          else
            await page(context, "loopLane", options, (cursor) =>
              context.api.listLoopLanes(workspace, id, options.limit, cursor),
            );
        }),
      );
  loop
    .command("descriptors")
    .action(async (_options, command) =>
      execute(runtime, command, readScopes, true, async (context) =>
        context.output.result(
          "loopEventCatalog",
          await context.api.listLoopEventDescriptors(
            context.requireWorkspace(),
          ),
        ),
      ),
    );
  loop
    .command("preview")
    .requiredOption("--timezone <timezone>")
    .requiredOption("--dtstart <local-time>")
    .option("--rrule <rule>")
    .action(
      async (
        options: { timezone: string; dtstart: string; rrule?: string },
        command,
      ) =>
        execute(runtime, command, readScopes, true, async (context) =>
          context.output.result(
            "loopSchedule",
            await context.api.previewLoopSchedule(
              context.requireWorkspace(),
              options,
            ),
          ),
        ),
    );
  const role = root
    .command("role")
    .description("Inspect and manage versioned workspace worker roles.");
  role
    .command("list")
    .option("--all")
    .addOption(limitOption(100))
    .action(async (options: PageOptions, command) =>
      execute(runtime, command, readScopes, true, async (context) =>
        page(context, "workerRole", options, (cursor) =>
          context.api.listWorkerRoles(
            context.requireWorkspace(),
            options.limit,
            cursor,
          ),
        ),
      ),
    );
  role
    .command("get <key>")
    .action(async (key: string, _options, command) =>
      execute(runtime, command, readScopes, true, async (context) =>
        context.output.result(
          "workerRole",
          await context.api.getWorkerRole(context.requireWorkspace(), key),
        ),
      ),
    );
  for (const action of ["create", "update"] as const) {
    const cmd = role
      .command(`${action} <key>`)
      .requiredOption("--name <name>")
      .requiredOption("--description <description>")
      .requiredOption("--instructions-file <path>");
    if (action === "update")
      cmd.requiredOption(
        "--expected-revision <number>",
        "Revision read by role get.",
        parsePositive,
      );
    cmd.action(
      async (
        roleKey: string,
        options: {
          name: string;
          description: string;
          instructionsFile: string;
          expectedRevision?: number;
        },
        command,
      ) =>
        execute(
          runtime,
          command,
          action === "create" ? createScopes : operateScopes,
          true,
          async (context) => {
            const body = {
              name: options.name,
              description: options.description,
              instructions: await readDefinitionFile(options.instructionsFile),
            };
            const key = mutationKey(command);
            context.output.beginMutation(key);
            const result =
              action === "create"
                ? await context.api.createWorkerRole(
                    context.requireWorkspace(),
                    { ...body, key: roleKey },
                    key,
                  )
                : await context.api.updateWorkerRole(
                    context.requireWorkspace(),
                    roleKey,
                    { ...body, expectedRevision: options.expectedRevision },
                    key,
                  );
            context.output.result(
              "workerRole",
              result.value,
              key,
              result.outcome,
            );
          },
        ),
    );
  }
  role
    .command("delete <key>")
    .action(async (roleKey: string, _options, command) =>
      mutation(
        runtime,
        command,
        (context, key) =>
          context.api.deleteWorkerRole(
            context.requireWorkspace(),
            roleKey,
            key,
          ),
        "workerRole",
      ),
    );
}

async function readDefinitionFile(path: string): Promise<string> {
  const stat = await fs.stat(path).catch(() => undefined);
  if (!stat?.isFile() || stat.size > 1_048_576)
    throw new UsageError(
      "Definition must be a readable regular UTF-8 file of at most 1 MiB.",
    );
  const bytes = await fs.readFile(path);
  if (bytes.length > 1_048_576)
    throw new UsageError("Definition must be at most 1 MiB.");
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new UsageError("Definition must be valid UTF-8.");
  }
  if (!text.trim()) throw new UsageError("Definition must not be empty.");
  return text;
}

function addTaskCreate(task: Command, runtime: Runtime): void {
  task
    .command("create")
    .option("--title <title>")
    .option("--visibility <visibility>", "", "workspace")
    .option("--retention <retention>", "", "ephemeral")
    .option("--repo <repository...>")
    .option("--active-repo <repository>")
    .option("--branch <branch>")
    .option("--pull-request <number>", "Existing PR number.", parsePositive)
    .option("--default-role <key>")
    .option("--role <key>")
    .option(
      "--no-auto-wake",
      "Disable generic resume restoration for finite workers.",
    )
    .addOption(
      new Option("--computer-idle-policy <policy>").choices([
        "idle_timeout",
        "suspend_after_turn",
      ]),
    )
    .option("--on-hold", "Create without admitting compute until released.")
    .option("--agent <agent>")
    .option("--model <model>")
    .option("--reasoning <effort>")
    .option("--cpu <cores>", "", parsePositive)
    .option("--memory <gb>", "", parsePositive)
    .option("--message <message>")
    .option("--message-file <path>")
    .option("--stdin")
    .action(async (options: CreateOptions, command) =>
      execute(runtime, command, createScopes, true, async (context) => {
        if (!["workspace", "private"].includes(options.visibility))
          throw new UsageError("--visibility must be workspace or private.");
        if (!["ephemeral", "persistent"].includes(options.retention))
          throw new UsageError("--retention must be ephemeral or persistent.");
        const repoValues = options.repo ?? [];
        if (repoValues.some((value) => !value.trim()))
          throw new UsageError("--repo values must not be empty.");
        if (options.branch !== undefined && !options.branch.trim())
          throw new UsageError("--branch must not be empty.");
        if (
          new Set(repoValues.map((x) => x.toLowerCase())).size !==
          repoValues.length
        )
          throw new UsageError(
            "Each --repo must identify a unique repository.",
          );
        if (options.pullRequest && (options.branch || repoValues.length !== 1))
          throw new UsageError(
            "--pull-request requires one --repo and cannot be combined with --branch.",
          );
        if (options.branch && repoValues.length !== 1)
          throw new UsageError("--branch requires exactly one --repo.");
        if (repoValues.length > 1 && !options.activeRepo)
          throw new UsageError(
            "--active-repo is required with multiple repositories.",
          );
        if (repoValues.length <= 1 && options.activeRepo)
          throw new UsageError(
            "--active-repo is valid only with multiple repositories.",
          );
        const repos = [];
        for (const reference of repoValues)
          repos.push(
            await resolveRepositoryItem(
              context.api,
              context.requireWorkspace(),
              reference,
            ),
          );
        let activeId = repos.length === 1 ? repos[0]!.id : undefined;
        if (repos.length > 1) {
          activeId = (
            await resolveRepositoryItem(
              context.api,
              context.requireWorkspace(),
              options.activeRepo!,
            )
          ).id;
          if (!repos.some((item) => item.id === activeId))
            throw new UsageError(
              "--active-repo must identify one of the selected --repo values.",
            );
        }
        const agent = await resolveAgent(
          context.api,
          context.requireWorkspace(),
          options.agent,
          options.model,
          options.reasoning,
        );
        const request = {
          message: await readMessage(options),
          ...(options.role ? { roleKey: options.role } : {}),
          agent,
          title: options.title ?? null,
          visibility: options.visibility,
          retentionMode: options.retention,
          autoWakeOnResume: options.autoWake,
          ...(options.onHold ? { createOnHold: true } : {}),
          ...(options.defaultRole
            ? { defaultRoleKey: options.defaultRole }
            : {}),
          ...(options.computerIdlePolicy
            ? { computerIdlePolicy: options.computerIdlePolicy }
            : {}),
          checkouts: repos.map((repo) => ({
            repositoryId: repo.id,
            isActive: repo.id === activeId,
            source: {
              kind: options.pullRequest
                ? "pull_request"
                : options.branch
                  ? "branch"
                  : "default",
              value: options.pullRequest
                ? String(options.pullRequest)
                : (options.branch ?? null),
            },
          })),
          ...(options.cpu ? { cpuCores: options.cpu } : {}),
          ...(options.memory ? { memoryGb: options.memory } : {}),
        };
        const key = mutationKey(command);
        context.output.beginMutation(key);
        const result = await context.api.createTask(
          context.requireWorkspace(),
          request,
          key,
        );
        context.output.result(
          "taskAccepted",
          result.value,
          key,
          result.outcome,
        );
      }),
    );
}

function addMessageMutation(
  task: Command,
  runtime: Runtime,
  name: string,
  action: (
    context: Context,
    taskId: string,
    options: MessageOptions & AgentOptions,
    key: string,
  ) => Promise<{ value: unknown; outcome?: string }>,
  kind: string,
): void {
  task
    .command(`${name} <task-id>`)
    .option("--role <key>")
    .option("--agent <agent>")
    .option("--model <model>")
    .option("--reasoning <effort>")
    .option("--message <message>")
    .option("--message-file <path>")
    .option("--stdin")
    .action(
      async (taskId: string, options: MessageOptions & AgentOptions, command) =>
        execute(runtime, command, operateScopes, true, async (context) => {
          const key = mutationKey(command);
          context.output.beginMutation(key);
          const result = await action(context, taskId, options, key);
          context.output.result(kind, result.value, key, result.outcome);
        }),
    );
}

function addWait(task: Command, runtime: Runtime): void {
  task
    .command("wait <task-id...>")
    .option("--after <task-sequence...>")
    .option("--timeout <seconds>", "", parseTimeout, 15)
    .action(
      async (
        taskIds: string[],
        options: { after?: string[]; timeout: number },
        command,
      ) =>
        execute(runtime, command, readScopes, true, async (context) => {
          const normalizedIds = taskIds.map(validId);
          if (
            normalizedIds.length > 8 ||
            new Set(normalizedIds).size !== normalizedIds.length
          )
            throw new UsageError("wait accepts one to eight unique task IDs.");
          const after = new Map<string, number>();
          for (const value of options.after ?? []) {
            const [id, sequence, ...rest] = value.split(":");
            const normalizedId = id ? validId(id) : "";
            if (
              !id ||
              !sequence ||
              rest.length ||
              !normalizedIds.includes(normalizedId) ||
              after.has(normalizedId)
            )
              throw new UsageError(
                "--after must use <task-id>:<sequence> once per wait target.",
              );
            after.set(normalizedId, parseNonNegative(sequence));
          }
          const targets = await Promise.all(
            normalizedIds.map(async (id) => ({
              taskId: id,
              afterSequence:
                after.get(id) ??
                (await context.api.getTask(id)).lastEventSequence,
            })),
          );
          context.output.result(
            "taskWait",
            await context.api.waitForTasks({
              targets,
              timeoutSeconds: options.timeout,
            }),
          );
        }),
    );
}

function addFollow(task: Command, runtime: Runtime): void {
  task
    .command("follow <task-id>")
    .option("--after-sequence <sequence>", "", parseNonNegative)
    .option("--timeout <seconds>", "", parseDuration)
    .action(
      async (
        taskId: string,
        options: { afterSequence?: number; timeout?: number },
        command,
      ) =>
        execute(runtime, command, readScopes, true, async (context) => {
          if (context.output.mode === "json")
            throw new UsageError(
              "task follow supports human or --jsonl output, not --json.",
            );
          const deadlineSignal = options.timeout
            ? AbortSignal.timeout(options.timeout)
            : undefined;
          const deadline = options.timeout
            ? Date.now() + options.timeout
            : undefined;
          let sequence = options.afterSequence ?? 0;
          let timedOut = false;
          try {
            const detail = await context.api.getTask(taskId, deadlineSignal);
            sequence = options.afterSequence ?? detail.lastEventSequence;
            while (true) {
              sequence = await readEvents(
                context,
                taskId,
                sequence,
                deadlineSignal,
              );
              const remaining = deadline ? deadline - Date.now() : undefined;
              if (remaining !== undefined && remaining <= 0) {
                timedOut = true;
                break;
              }
              const seconds = Math.min(
                30,
                remaining === undefined
                  ? 30
                  : Math.max(1, Math.ceil(remaining / 1000)),
              );
              const wait = await context.api.waitForTasks(
                {
                  targets: [{ taskId, afterSequence: sequence }],
                  timeoutSeconds: seconds,
                },
                deadlineSignal,
              );
              const snapshot = wait.tasks[0];
              if (snapshot && isTerminalTaskStatus(String(snapshot.status))) {
                sequence = await readEvents(
                  context,
                  taskId,
                  sequence,
                  deadlineSignal,
                );
                break;
              }
            }
          } catch (error) {
            if (deadlineSignal?.aborted && isFollowDeadlineError(error))
              timedOut = true;
            else throw error;
          }
          if (context.output.mode === "jsonl")
            context.output.result("followEnd", {
              taskId,
              lastEventSequence: sequence,
              timedOut,
            });
        }),
    );
}

async function readEvents(
  context: Context,
  taskId: string,
  after: number,
  signal?: AbortSignal,
): Promise<number> {
  return await readAvailableEvents(
    context.api,
    taskId,
    after,
    (event) => context.output.result("taskEvent", event),
    async (milliseconds) => await sleep(milliseconds, undefined, { signal }),
    signal,
  );
}

function isFollowDeadlineError(error: unknown): boolean {
  return (
    (error instanceof CliError && error.exitCode === ExitCode.interrupted) ||
    (error instanceof Error &&
      (error.name === "AbortError" || error.name === "TimeoutError"))
  );
}

async function mutation(
  runtime: Runtime,
  command: Command,
  action: (
    context: Context,
    key: string,
  ) => Promise<{ value: unknown; outcome?: string }>,
  kind: string,
  warning?: string,
): Promise<void> {
  await execute(runtime, command, operateScopes, true, async (context) => {
    const key = mutationKey(command);
    context.output.beginMutation(key);
    const result = await action(context, key);
    context.output.result(kind, result.value, key, result.outcome);
    if (warning) context.output.warning(warning);
  });
}

async function execute(
  runtime: Runtime,
  command: Command,
  scopes: readonly string[],
  resolveWorkspace: boolean,
  action: CommandAction,
): Promise<void> {
  const globals = globalOptions(command);
  let output: Output | undefined;
  try {
    const isMutation = scopes.some(
      (scope) =>
        scope === "cobaltcode.external.operate" ||
        scope === "cobaltcode.external.create",
    );
    if (!isMutation && globals.idempotencyKey)
      throw new UsageError("--idempotency-key is valid only for mutations.");
    const context = await runtime.context(globals, scopes, resolveWorkspace);
    output = context.output;
    await action(context);
    output.complete();
  } catch (error) {
    let environment;
    try {
      environment = resolveEnvironment(
        globals.environment ?? process.env.COBALT_ENVIRONMENT,
      );
    } catch {
      environment = resolveEnvironment("prod");
    }
    output ??= new Output(
      environment,
      globals.json ? "json" : globals.jsonl ? "jsonl" : "human",
      globals.quiet,
    );
    const exitCode =
      error instanceof CliError ? error.exitCode : ExitCode.failure;
    output.error(error, exitCode);
    process.exitCode = exitCode;
  }
}

export async function runProgram(
  runtime: Runtime,
  argv: string[],
): Promise<number> {
  const program = createProgram(runtime);
  program.configureOutput({ writeErr: () => undefined });
  try {
    await program.parseAsync(argv, { from: "user" });
    return Number(process.exitCode ?? 0);
  } catch (error) {
    if (error instanceof CommanderError || error instanceof CliError) {
      if (
        error instanceof CommanderError &&
        (error.code === "commander.helpDisplayed" ||
          error.code === "commander.version")
      )
        return 0;
      const environmentIndex = argv.indexOf("--environment");
      let environment;
      try {
        environment = resolveEnvironment(
          environmentIndex >= 0 ? argv[environmentIndex + 1] : undefined,
        );
      } catch {
        environment = resolveEnvironment("prod");
      }
      const output = new Output(
        environment,
        argv.includes("--json")
          ? "json"
          : argv.includes("--jsonl")
            ? "jsonl"
            : "human",
        argv.includes("--quiet"),
      );
      const handled =
        error instanceof CommanderError
          ? new UsageError(error.message.replace(/^error:\s*/i, ""))
          : error;
      output.error(handled, handled.exitCode);
      return handled.exitCode;
    }
    throw error;
  }
}

interface PageOptions {
  all?: boolean;
  limit: number;
}
interface AgentOptions {
  agent?: string;
  model?: string;
  reasoning?: string;
}
interface MessageOptions {
  role?: string;
  message?: string;
  messageFile?: string;
  stdin?: boolean;
}
interface CreateOptions extends AgentOptions, MessageOptions {
  title?: string;
  visibility: string;
  retention: string;
  repo?: string[];
  activeRepo?: string;
  branch?: string;
  pullRequest?: number;
  defaultRole?: string;
  autoWake: boolean;
  onHold?: boolean;
  computerIdlePolicy?: string;
  cpu?: number;
  memory?: number;
}

async function page<T>(
  context: Context,
  kind: string,
  options: PageOptions,
  load: (cursor?: string) => Promise<PageLike<T>>,
): Promise<void> {
  let finalPage: PageLike<T> | undefined;
  await allPages(load, Boolean(options.all), (items, current) => {
    context.output.result(kind, items);
    finalPage = current;
  });
  if (context.output.mode === "jsonl" && finalPage)
    context.output.pageEnd(finalPage.hasMore, finalPage.nextCursor);
}

async function readMessage(options: MessageOptions): Promise<string> {
  const sources =
    Number(options.message !== undefined) +
    Number(options.messageFile !== undefined) +
    Number(Boolean(options.stdin));
  if (sources !== 1)
    throw new UsageError(
      "Exactly one of --message, --message-file, or --stdin is required.",
    );
  let bytes: Uint8Array;
  if (options.message !== undefined) return validateMessage(options.message);
  if (options.messageFile) {
    const stat = await fs.stat(options.messageFile).catch(() => undefined);
    if (!stat?.isFile())
      throw new UsageError("The message file must be a regular readable file.");
    if (stat.size > 262_144)
      throw new UsageError("Message exceeds 65,536 characters.");
    bytes = await fs.readFile(options.messageFile);
  } else {
    const chunks: Buffer[] = [];
    for await (const chunk of process.stdin) {
      chunks.push(Buffer.from(chunk));
      if (chunks.reduce((sum, item) => sum + item.length, 0) > 262_144) break;
    }
    bytes = Buffer.concat(chunks);
  }
  if (bytes.length > 262_144)
    throw new UsageError("Message exceeds 65,536 characters.");
  try {
    return validateMessage(
      new TextDecoder("utf-8", { fatal: true }).decode(bytes),
    );
  } catch (error) {
    if (error instanceof UsageError) throw error;
    throw new UsageError("The message input must be valid UTF-8.");
  }
}

function validateMessage(value: string): string {
  if (!value.trim() || value.length > 65_536)
    throw new UsageError("Message must contain 1 to 65,536 characters.");
  return value;
}
function validateSearch(value: string): void {
  if (!value.trim() || [...value].length > 256)
    throw new UsageError(
      "Search query must contain between 1 and 256 Unicode scalar values.",
    );
}
function mutationKey(command: Command): string {
  const value = globalOptions(command).idempotencyKey ?? crypto.randomUUID();
  return validId(value);
}
function globalOptions(command: Command): GlobalOptions {
  return command.optsWithGlobals() as GlobalOptions;
}
function hasAgentSelection(options: AgentOptions): boolean {
  return Boolean(options.agent || options.model || options.reasoning);
}
function limitOption(maximum: number): Option {
  return new Option("--limit <number>").default(maximum).argParser((value) => {
    const parsed = Number(value);
    if (!Number.isInteger(parsed) || parsed < 1 || parsed > maximum)
      throw new UsageError(`--limit must be between 1 and ${maximum}.`);
    return parsed;
  });
}
function parseNonNegative(value: string): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0)
    throw new UsageError("Sequence must be a non-negative integer.");
  return parsed;
}
function parsePositive(value: string): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0)
    throw new UsageError("Value must be a positive integer.");
  return parsed;
}
function parseTimeout(value: string): number {
  const parsed = parsePositive(value);
  if (parsed > 30)
    throw new UsageError("--timeout must be between 1 and 30 seconds.");
  return parsed;
}
function parseDuration(value: string): number {
  const match = /^(\d+)(ms|s|m|h)?$/.exec(value);
  if (!match) throw new UsageError("--timeout must be a positive duration.");
  const amount = Number(match[1]);
  const milliseconds =
    amount * { ms: 1, s: 1_000, m: 60_000, h: 3_600_000 }[match[2] ?? "s"]!;
  if (
    !Number.isSafeInteger(milliseconds) ||
    milliseconds <= 0 ||
    milliseconds > maximumTimerMilliseconds
  )
    throw new UsageError(
      `--timeout must be between 1ms and ${maximumTimerMilliseconds}ms.`,
    );
  return milliseconds;
}
function completion(shell: string): string | undefined {
  if (shell === "bash")
    return `_cobalt_complete() {
  local commands="interactive auth workspace repo agent task loop role completion version"
  local auth="login logout status" workspace="list use current" repo="list" agent="list"
  local task="list get search create messages message-search events send steer cancel suspend resume auto-wake queue delete wait follow open"
  local loop="list get create update enable disable delete run rerun runs decisions lanes descriptors preview" role="list get create update delete"
  local previous="\${COMP_WORDS[COMP_CWORD-1]}" choices="$commands"
  case "\${COMP_WORDS[1]}" in auth) choices="$auth";; workspace) choices="$workspace";; repo) choices="$repo";; agent) choices="$agent";; task) choices="$task";; loop) choices="$loop";; role) choices="$role";; esac
  COMPREPLY=( $(compgen -W "$choices --environment --workspace --json --jsonl --quiet --no-color --trace --idempotency-key --help --version" -- "\${COMP_WORDS[COMP_CWORD]}") )
}
complete -F _cobalt_complete cobalt`;
  if (shell === "zsh")
    return `#compdef cobalt
_cobalt() {
  local -a commands
  commands=(interactive auth workspace repo agent task loop role completion version)
  if (( CURRENT == 2 )); then _describe command commands; return; fi
  case $words[2] in
    auth) _values action login logout status;;
    workspace) _values action list use current;;
    repo|agent) _values action list;;
    task) _values action list get search create messages message-search events send steer cancel suspend resume auto-wake queue delete wait follow open;;
    loop) _values action list get create update enable disable delete run rerun runs decisions lanes descriptors preview;;
    role) _values action list get create update delete;;
    completion) _values shell bash zsh fish powershell;;
    *) _arguments '*:argument:';;
  esac
}
compdef _cobalt cobalt`;
  if (shell === "fish")
    return `complete -c cobalt -f
complete -c cobalt -n '__fish_use_subcommand' -a 'interactive auth workspace repo agent task loop role completion version'
complete -c cobalt -n '__fish_seen_subcommand_from auth' -a 'login logout status'
complete -c cobalt -n '__fish_seen_subcommand_from workspace' -a 'list use current'
complete -c cobalt -n '__fish_seen_subcommand_from repo agent' -a 'list'
complete -c cobalt -n '__fish_seen_subcommand_from task' -a 'list get search create messages message-search events send steer cancel suspend resume auto-wake queue delete wait follow open'
complete -c cobalt -n '__fish_seen_subcommand_from loop' -a 'list get create update enable disable delete run rerun runs decisions lanes descriptors preview'
complete -c cobalt -n '__fish_seen_subcommand_from role' -a 'list get create update delete'
complete -c cobalt -l environment -a 'prod dev demo local'`;
  if (shell === "powershell")
    return `Register-ArgumentCompleter -Native -CommandName cobalt -ScriptBlock {
  param($wordToComplete, $commandAst, $cursorPosition)
  $words = @('interactive','auth','workspace','repo','agent','task','loop','role','completion','version','login','logout','status','list','use','current','get','search','create','messages','message-search','events','send','steer','cancel','suspend','resume','delete','wait','follow','open','auto-wake','queue','hold','release','retry','move','update','enable','disable','run','rerun','schedules','preview','descriptors','runs','decisions','lanes','prod','dev','demo','local','bash','zsh','fish','powershell')
  $words | Where-Object { $_ -like "$wordToComplete*" } | ForEach-Object { [System.Management.Automation.CompletionResult]::new($_,$_, 'ParameterValue', $_) }
}`;
  return undefined;
}
