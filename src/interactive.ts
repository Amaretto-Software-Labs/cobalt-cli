import readline from "node:readline/promises";
import { login, logout, openBrowser } from "./auth.js";
import { CliError, ExitCode, UsageError } from "./errors.js";
import { readAvailableEvents } from "./events.js";
import { sanitize } from "./output.js";
import {
  resolveAgent,
  resolveRepositoryItem,
  resolveWorkspaceItem,
  type Context,
  type PageLike,
  type Runtime,
} from "./runtime.js";
import { isTerminalTaskStatus } from "./task-status.js";

export async function runInteractive(
  runtime: Runtime,
  initialContext: Context,
  initialTask?: string,
): Promise<void> {
  if (!process.stdin.isTTY || !process.stdout.isTTY)
    throw new UsageError("interactive requires terminal input and output.");
  let context = initialContext;
  const terminal = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    terminal: true,
  });
  const foreground = new InteractiveForegroundOperation();
  const mutations = new InteractiveMutationCoordinator();
  const cancelForeground = () => foreground.cancel();
  terminal.on("SIGINT", cancelForeground);
  let activeTask = initialTask;
  let eventSequence = 0;
  try {
    if (activeTask) {
      try {
        eventSequence = (
          await context.api.getTask(activeTask, foreground.signal)
        ).lastEventSequence;
      } catch (error) {
        if (!isInteractiveAbort(error)) throw error;
        writeInteractive("^C\n");
        activeTask = undefined;
      }
    }
    writeInteractive("Cobalt interactive session. Type /help for commands.\n");
    while (true) {
      const signal = foreground.renew();
      let line: string;
      try {
        line = await ask(
          terminal,
          signal,
          `cobalt[${context.environment.name}:${interactiveWorkspaceLabel(context, "no-workspace")}:${activeTask?.slice(0, 8) ?? "no-task"}]> `,
        );
      } catch (error) {
        if (isInteractiveAbort(error)) {
          writeInteractive("^C\n");
          continue;
        }
        throw error;
      }
      if (!line.trim()) continue;
      try {
        if (!line.startsWith("/") || line.startsWith("//")) {
          const taskId = requireTask(activeTask);
          const message = line.startsWith("//") ? line.slice(1) : line;
          await context.tokenProvider.preflight([
            "cobaltcode.external.operate",
          ]);
          validateInteractiveMessage(message);
          await mutations.execute(
            "send message",
            async (key, operationSignal) =>
              await context.api.sendMessage(
                taskId,
                { message },
                key,
                operationSignal,
              ),
            async (result, key, operationSignal) => {
              eventSequence = mergeInteractiveEventSequence(
                eventSequence,
                result.value.lastEventSequence,
              );
              writeInteractive(
                `Accepted message ${result.value.messageId} with idempotency key ${key}.\n`,
              );
              ({ activeTask, eventSequence } = await followTask(
                context,
                taskId,
                eventSequence,
                operationSignal,
              ));
            },
            signal,
          );
          continue;
        }
        const [command, ...args] = parseInteractiveLine(line);
        if (
          mutations.hasPending &&
          !isInteractiveCommandAllowedWhilePending(command)
        )
          throw new UsageError(
            "Replay the pending ambiguous mutation with /retry before changing context or starting another mutation.",
          );
        if (command === "/exit") break;
        if (command === "/help") {
          help();
          continue;
        }
        if (command === "/clear") {
          // This fixed local command is the only intentional terminal control sequence.
          process.stdout.write("\u001b[2J\u001b[H");
          continue;
        }
        if (command === "/retry") {
          const replayed = await mutations.retry(signal);
          writeInteractive(
            `Replayed ${replayed.label} with idempotency key ${replayed.key}.\n`,
          );
          continue;
        }
        if (command === "/leave") {
          activeTask = undefined;
          eventSequence = 0;
          continue;
        }
        if (command === "/status") {
          writeInteractive(
            `${context.environment.name}  workspace=${interactiveWorkspaceLabel(context, "none")}  task=${activeTask ?? "none"}\n`,
          );
          continue;
        }
        if (command === "/workspaces") {
          const item = await selectPaged(
            (cursor) => context.api.listWorkspaces(100, cursor, signal),
            (item) => `${item.id}  ${item.name}`,
            (item) => item.id,
            terminal,
            signal,
            "workspace",
          );
          if (item) {
            context.workspaceId = item.id;
            context.workspaceName = item.name;
            context.config.environments[context.environment.name] = {
              workspaceId: item.id,
              workspaceName: item.name,
            };
            await context.configStore.save(context.config);
            activeTask = undefined;
            eventSequence = 0;
          }
          continue;
        }
        if (command === "/workspace") {
          const reference = args.join(" ");
          const item = reference
            ? await resolveWorkspaceItem(context.api, reference, signal)
            : await selectPaged(
                (cursor) => context.api.listWorkspaces(100, cursor, signal),
                (workspace) => `${workspace.id}  ${workspace.name}`,
                (workspace) => workspace.id,
                terminal,
                signal,
                "workspace",
              );
          if (!item) continue;
          context.workspaceId = item.id;
          context.workspaceName = item.name;
          context.config.environments[context.environment.name] = {
            workspaceId: item.id,
            workspaceName: item.name,
          };
          await context.configStore.save(context.config);
          activeTask = undefined;
          eventSequence = 0;
          continue;
        }
        if (command === "/repos") {
          await browse(
            (cursor) =>
              context.api.listRepositories(
                context.requireWorkspace(),
                100,
                cursor,
                signal,
              ),
            (item) => `${item.id}  ${item.displayName}  ${item.status}`,
            terminal,
            signal,
            "repositories",
          );
          continue;
        }
        if (command === "/agents") {
          await browse(
            (cursor) =>
              context.api.listAgents(
                context.requireWorkspace(),
                100,
                cursor,
                signal,
              ),
            (item) => `${item.id}  ${item.label}  ${item.status}`,
            terminal,
            signal,
            "agent accounts",
          );
          continue;
        }
        if (command === "/tasks") {
          const item = await selectPaged(
            (cursor) =>
              context.api.listTasks(
                context.requireWorkspace(),
                {
                  limit: 100,
                  ...(cursor ? { cursor } : {}),
                },
                signal,
              ),
            (item) => `${item.id}  ${item.status}  ${item.title}`,
            (item) => item.id,
            terminal,
            signal,
            "task",
          );
          if (item) {
            activeTask = item.id;
            eventSequence = (await context.api.getTask(activeTask, signal))
              .lastEventSequence;
          }
          continue;
        }
        if (command === "/search") {
          const query = args.join(" ");
          if (!query) throw new UsageError("Usage: /search <query>");
          const item = await selectPaged(
            (cursor) =>
              context.api.searchTasks(
                context.requireWorkspace(),
                {
                  query,
                  limit: 50,
                  ...(cursor ? { cursor } : {}),
                },
                signal,
              ),
            JSON.stringify,
            (item) => item.taskId,
            terminal,
            signal,
            "task",
          );
          if (item) {
            activeTask = item.taskId;
            eventSequence = (await context.api.getTask(activeTask, signal))
              .lastEventSequence;
          }
          continue;
        }
        if (command === "/enter") {
          activeTask = args[0] ?? (await ask(terminal, signal, "Task UUID: "));
          eventSequence = (await context.api.getTask(activeTask, signal))
            .lastEventSequence;
          continue;
        }
        if (command === "/show") {
          writeInteractive(
            `${JSON.stringify(await context.api.getTask(requireTask(activeTask), signal))}\n`,
          );
          continue;
        }
        if (command === "/messages") {
          await browse(
            (cursor) =>
              context.api.listMessages(
                requireTask(activeTask),
                100,
                cursor,
                signal,
              ),
            (item) => `[${item.sequence}] ${item.author}: ${item.content}`,
            terminal,
            signal,
            "messages",
          );
          continue;
        }
        if (command === "/message-search") {
          const query = args.join(" ");
          if (!query) throw new UsageError("Usage: /message-search <query>");
          await browse(
            (cursor) =>
              context.api.searchMessages(
                context.requireWorkspace(),
                {
                  query,
                  taskId: requireTask(activeTask),
                  limit: 50,
                  ...(cursor ? { cursor } : {}),
                },
                signal,
              ),
            JSON.stringify,
            terminal,
            signal,
            "message search results",
          );
          continue;
        }
        if (command === "/events") {
          eventSequence = await printEvents(
            context,
            requireTask(activeTask),
            0,
            signal,
          );
          continue;
        }
        if (command === "/send") {
          const follow = args[0] !== "--no-follow";
          const text = args.slice(follow ? 0 : 1).join(" ");
          if (!text)
            throw new UsageError("Usage: /send [--no-follow] <message>");
          validateInteractiveMessage(text);
          await context.tokenProvider.preflight([
            "cobaltcode.external.operate",
          ]);
          const taskId = requireTask(activeTask);
          await mutations.execute(
            "send message",
            async (key, operationSignal) =>
              await context.api.sendMessage(
                taskId,
                { message: text },
                key,
                operationSignal,
              ),
            async (result, key, operationSignal) => {
              eventSequence = mergeInteractiveEventSequence(
                eventSequence,
                result.value.lastEventSequence,
              );
              writeInteractive(
                `Accepted message ${result.value.messageId} with idempotency key ${key}.\n`,
              );
              if (follow)
                ({ activeTask, eventSequence } = await followTask(
                  context,
                  taskId,
                  eventSequence,
                  operationSignal,
                ));
            },
            signal,
          );
          continue;
        }
        if (command === "/compose") {
          const lines: string[] = [];
          writeInteractive(
            "Enter message; finish with /send or discard with /abort.\n",
          );
          while (true) {
            const draft = await ask(terminal, signal, "");
            if (draft === "/abort") break;
            if (draft === "/send") {
              const message = lines.join("\n");
              validateInteractiveMessage(message);
              const taskId = requireTask(activeTask);
              await context.tokenProvider.preflight([
                "cobaltcode.external.operate",
              ]);
              await mutations.execute(
                "send composed message",
                async (key, operationSignal) =>
                  await context.api.sendMessage(
                    taskId,
                    { message },
                    key,
                    operationSignal,
                  ),
                async (result, key, operationSignal) => {
                  eventSequence = mergeInteractiveEventSequence(
                    eventSequence,
                    result.value.lastEventSequence,
                  );
                  writeInteractive(
                    `Accepted message ${result.value.messageId} with idempotency key ${key}.\n`,
                  );
                  ({ activeTask, eventSequence } = await followTask(
                    context,
                    taskId,
                    eventSequence,
                    operationSignal,
                  ));
                },
                signal,
              );
              break;
            }
            lines.push(draft.startsWith("//") ? draft.slice(1) : draft);
          }
          continue;
        }
        if (command === "/steer") {
          if (!args[0]) throw new UsageError("Usage: /steer <message-id>");
          await context.tokenProvider.preflight([
            "cobaltcode.external.operate",
          ]);
          const taskId = requireTask(activeTask);
          const messageId = args[0];
          await mutations.execute(
            "steer message",
            async (key, operationSignal) =>
              await context.api.steerMessage(
                taskId,
                messageId,
                key,
                operationSignal,
              ),
            async (_result, key) =>
              writeInteractive(`Accepted steer with idempotency key ${key}.\n`),
            signal,
          );
          continue;
        }
        if (command === "/cancel") {
          if (
            !(await confirm(terminal, signal, "Cancel the active turn? [y/N] "))
          )
            continue;
          await context.tokenProvider.preflight([
            "cobaltcode.external.operate",
          ]);
          const taskId = requireTask(activeTask);
          await mutations.execute(
            "cancel turn",
            async (key, operationSignal) =>
              await context.api.cancelTurn(taskId, key, operationSignal),
            async (_result, key) => {
              writeInteractive(
                `Accepted cancel with idempotency key ${key}.\n`,
              );
              writeInteractive(
                "cobalt: warning: partial file, Git, or provider changes may remain.\n",
                "stderr",
              );
            },
            signal,
          );
          continue;
        }
        if (command === "/suspend") {
          if (
            !(await confirm(
              terminal,
              signal,
              "Suspend the task computer? [y/N] ",
            ))
          )
            continue;
          await context.tokenProvider.preflight([
            "cobaltcode.external.operate",
          ]);
          const taskId = requireTask(activeTask);
          await mutations.execute(
            "suspend task",
            async (key, operationSignal) =>
              await context.api.suspendTask(taskId, key, operationSignal),
            async (_result, key) =>
              writeInteractive(
                `Accepted suspension with idempotency key ${key}.\n`,
              ),
            signal,
          );
          continue;
        }
        if (command === "/resume") {
          await context.tokenProvider.preflight([
            "cobaltcode.external.operate",
          ]);
          const taskId = requireTask(activeTask);
          await mutations.execute(
            "resume task",
            async (key, operationSignal) =>
              await context.api.resumeTask(taskId, {}, key, operationSignal),
            async (_result, key) =>
              writeInteractive(
                `Accepted resume with idempotency key ${key}.\n`,
              ),
            signal,
          );
          continue;
        }
        if (command === "/wait") {
          const seconds = args[0] ? Number(args[0]) : 15;
          if (!Number.isInteger(seconds) || seconds < 1 || seconds > 30)
            throw new UsageError("Wait seconds must be between 1 and 30.");
          const id = requireTask(activeTask);
          writeInteractive(
            `${JSON.stringify(await context.api.waitForTasks({ targets: [{ taskId: id, afterSequence: eventSequence }], timeoutSeconds: seconds }, signal))}\n`,
          );
          continue;
        }
        if (command === "/follow") {
          ({ activeTask, eventSequence } = await followTask(
            context,
            requireTask(activeTask),
            eventSequence,
            signal,
          ));
          continue;
        }
        if (command === "/open") {
          const id = requireTask(activeTask);
          await context.api.getTask(id, signal);
          await openBrowser(
            new URL(`/chats/${id}`, context.environment.webFrontend).toString(),
          );
          continue;
        }
        if (command === "/login") {
          await login(
            context.environment,
            context.credentialStore,
            false,
            true,
            signal,
          );
          continue;
        }
        if (command === "/logout") {
          if (
            !(await confirm(
              terminal,
              signal,
              `Log out of ${context.environment.name}? [y/N] `,
            ))
          )
            continue;
          await logout(context.environment, context.credentialStore, signal);
          context = await runtime.context(
            { environment: context.environment.name },
            ["cobaltcode.external.read"],
            true,
          );
          activeTask = undefined;
          eventSequence = 0;
          continue;
        }
        if (command === "/environment") {
          const environment =
            args[0] ??
            (await ask(terminal, signal, "Environment (prod/dev/demo): "));
          if (
            environment !== context.environment.name &&
            !(await confirm(
              terminal,
              signal,
              `Switch from ${context.environment.name} to ${environment} and clear active task context? [y/N] `,
            ))
          )
            continue;
          context = await runtime.context(
            { environment },
            ["cobaltcode.external.read"],
            true,
          );
          activeTask = undefined;
          eventSequence = 0;
          continue;
        }
        if (command === "/new") {
          await context.tokenProvider.preflight(["cobaltcode.external.create"]);
          const message = await ask(terminal, signal, "Initial message: ");
          if (!message.trim() || message.length > 65_536)
            throw new UsageError(
              "Message must contain 1 to 65,536 characters.",
            );
          const repositoryInputs = (
            await ask(
              terminal,
              signal,
              "Repositories (comma-separated names or UUIDs; blank for none): ",
            )
          )
            .split(",")
            .map((value) => value.trim())
            .filter(Boolean);
          const repositories: Awaited<
            ReturnType<typeof resolveRepositoryItem>
          >[] = [];
          for (const reference of repositoryInputs)
            repositories.push(
              await resolveRepositoryItem(
                context.api,
                context.requireWorkspace(),
                reference,
                signal,
              ),
            );
          const activeReference =
            repositories.length > 1
              ? await ask(terminal, signal, "Active repository name or UUID: ")
              : undefined;
          const activeId =
            repositories.length === 1
              ? repositories[0]!.id
              : activeReference
                ? (
                    await resolveRepositoryItem(
                      context.api,
                      context.requireWorkspace(),
                      activeReference,
                      signal,
                    )
                  ).id
                : undefined;
          if (activeId && !repositories.some((item) => item.id === activeId))
            throw new UsageError(
              "The active repository must be one of the selected repositories.",
            );
          const agentReference =
            (
              await ask(
                terminal,
                signal,
                "Agent name or UUID (blank for default): ",
              )
            ).trim() || undefined;
          const model =
            (
              await ask(
                terminal,
                signal,
                "Model ID (blank for account default): ",
              )
            ).trim() || undefined;
          const reasoning =
            (
              await ask(
                terminal,
                signal,
                "Reasoning effort (blank for model default): ",
              )
            ).trim() || undefined;
          const title =
            (
              await ask(terminal, signal, "Title (blank for automatic): ")
            ).trim() || null;
          const visibility =
            (
              await ask(
                terminal,
                signal,
                "Visibility [workspace/private] (workspace): ",
              )
            ).trim() || "workspace";
          const retentionMode =
            (
              await ask(
                terminal,
                signal,
                "Retention [ephemeral/persistent] (ephemeral): ",
              )
            ).trim() || "ephemeral";
          const branch =
            repositories.length === 1
              ? (
                  await ask(
                    terminal,
                    signal,
                    "Branch (blank for repository default): ",
                  )
                ).trim() || undefined
              : undefined;
          const cpuInput = (
            await ask(
              terminal,
              signal,
              "CPU cores (blank for workspace default): ",
            )
          ).trim();
          const memoryInput = (
            await ask(
              terminal,
              signal,
              "Memory GB (blank for workspace default): ",
            )
          ).trim();
          const cpuCores = cpuInput ? Number(cpuInput) : undefined;
          const memoryGb = memoryInput ? Number(memoryInput) : undefined;
          if (
            (cpuCores !== undefined &&
              (!Number.isInteger(cpuCores) || cpuCores <= 0)) ||
            (memoryGb !== undefined &&
              (!Number.isInteger(memoryGb) || memoryGb <= 0))
          )
            throw new UsageError(
              "CPU and memory values must be positive integers.",
            );
          if (
            !["workspace", "private"].includes(visibility) ||
            !["ephemeral", "persistent"].includes(retentionMode)
          )
            throw new UsageError(
              "Visibility or retention selection is invalid.",
            );
          const agent = await resolveAgent(
            context.api,
            context.requireWorkspace(),
            agentReference,
            model,
            reasoning,
            signal,
          );
          const operationContext = context;
          const workspaceId = context.requireWorkspace();
          await mutations.execute(
            "create task",
            async (key, operationSignal) =>
              await operationContext.api.createTask(
                workspaceId,
                {
                  message,
                  agent,
                  title,
                  visibility,
                  retentionMode,
                  checkouts: repositories.map((item) => ({
                    repositoryId: item.id,
                    isActive: item.id === activeId,
                    source: {
                      kind: branch ? "branch" : "default",
                      value: branch ?? null,
                    },
                  })),
                  ...(cpuCores ? { cpuCores } : {}),
                  ...(memoryGb ? { memoryGb } : {}),
                },
                key,
                operationSignal,
              ),
            async (result, key) => {
              activeTask = String(result.value.taskId);
              eventSequence = Number(result.value.lastEventSequence);
              writeInteractive(
                `Created task ${activeTask} with idempotency key ${key}.\n`,
              );
            },
            signal,
          );
          continue;
        }
        throw new UsageError(`Unknown interactive command '${command}'.`);
      } catch (error) {
        if (isInteractiveAbort(error)) {
          writeInteractive("^C\n");
          continue;
        }
        writeInteractive(
          `cobalt: ${error instanceof Error ? error.message : String(error)}\n`,
          "stderr",
        );
      }
    }
  } finally {
    terminal.off("SIGINT", cancelForeground);
    foreground.dispose();
    terminal.close();
  }
}

export function interactiveWorkspaceLabel(
  context: Pick<Context, "workspaceId" | "workspaceName">,
  empty: string,
): string {
  return context.workspaceName ?? context.workspaceId ?? empty;
}

export function mergeInteractiveEventSequence(
  current: number,
  accepted: number | undefined,
): number {
  return Math.max(current, accepted ?? current);
}

function validateInteractiveMessage(message: string): void {
  if (!message.trim() || message.length > 65_536)
    throw new UsageError("Message must contain 1 to 65,536 characters.");
}

async function confirm(
  terminal: readline.Interface,
  signal: AbortSignal,
  prompt: string,
): Promise<boolean> {
  const answer = await ask(terminal, signal, prompt);
  return answer.toLowerCase() === "y" || answer.toLowerCase() === "yes";
}
async function followTask(
  context: Context,
  taskId: string,
  sequence: number,
  signal: AbortSignal,
): Promise<{ activeTask: string; eventSequence: number }> {
  while (true) {
    sequence = await printEvents(context, taskId, sequence, signal);
    const wait = await context.api.waitForTasks(
      {
        targets: [{ taskId, afterSequence: sequence }],
        timeoutSeconds: 30,
      },
      signal,
    );
    const snapshot = ((wait.tasks as Record<string, unknown>[] | undefined) ??
      [])[0];
    if (snapshot && isTerminalTaskStatus(String(snapshot.status))) {
      sequence = await printEvents(context, taskId, sequence, signal);
      return { activeTask: taskId, eventSequence: sequence };
    }
  }
}
async function printEvents(
  context: Context,
  taskId: string,
  sequence: number,
  signal: AbortSignal,
): Promise<number> {
  return await readAvailableEvents(
    context.api,
    taskId,
    sequence,
    (event) => writeInteractive(`[${event.sequence}] ${event.eventType}\n`),
    undefined,
    signal,
  );
}
async function browse<T>(
  load: (cursor?: string) => Promise<PageLike<T>>,
  format: (item: T) => string,
  terminal: readline.Interface,
  signal: AbortSignal,
  noun: string,
): Promise<void> {
  const cursors: (string | undefined)[] = [undefined];
  while (true) {
    const page = await load(cursors.at(-1));
    page.items.forEach((item, index) =>
      writeInteractive(`${String(index + 1).padStart(3)}. ${format(item)}\n`),
    );
    if (!page.items.length && cursors.length === 1 && !page.hasMore) {
      writeInteractive(`No ${noun} found.\n`);
      return;
    }
    if (!page.hasMore && cursors.length === 1) return;
    writeInteractive(
      `Actions:${page.hasMore ? " next" : ""}${cursors.length > 1 ? " back" : ""} cancel\n`,
    );
    const choice = (
      await ask(terminal, signal, `${noun}: next, back, or cancel: `)
    )
      .trim()
      .toLowerCase();
    if (!choice || choice === "cancel" || choice === "c") return;
    if (choice === "next" || choice === "n") {
      if (!page.hasMore) {
        writeInteractive("No next page.\n");
        continue;
      }
      cursors.push(requireNextCursor(page.nextCursor, cursors));
      continue;
    }
    if (choice === "back" || choice === "b") {
      if (cursors.length === 1) {
        writeInteractive("Already on the first page.\n");
        continue;
      }
      cursors.pop();
      continue;
    }
    throw new UsageError("Choose next, back, or cancel.");
  }
}

export async function selectPaged<T>(
  load: (cursor?: string) => Promise<PageLike<T>>,
  format: (item: T) => string,
  id: (item: T) => string,
  terminal: readline.Interface,
  signal: AbortSignal,
  noun: string,
): Promise<T | undefined> {
  const cursors: (string | undefined)[] = [undefined];
  while (true) {
    const page = await load(cursors.at(-1));
    page.items.forEach((item, index) =>
      writeInteractive(`${String(index + 1).padStart(3)}. ${format(item)}\n`),
    );
    if (!page.items.length && cursors.length === 1 && !page.hasMore) {
      writeInteractive(`No ${noun}s found.\n`);
      return undefined;
    }
    writeInteractive(
      `Actions:${page.hasMore ? " next" : ""}${cursors.length > 1 ? " back" : ""} cancel\n`,
    );
    const choice = (
      await ask(
        terminal,
        signal,
        `Select ${noun} number, next, back, or cancel: `,
      )
    ).trim();
    const normalized = choice.toLowerCase();
    if (!choice || normalized === "cancel" || normalized === "c")
      return undefined;
    if (normalized === "next" || normalized === "n") {
      if (!page.hasMore) {
        writeInteractive("No next page.\n");
        continue;
      }
      cursors.push(requireNextCursor(page.nextCursor, cursors));
      continue;
    }
    if (normalized === "back" || normalized === "b") {
      if (cursors.length === 1) {
        writeInteractive("Already on the first page.\n");
        continue;
      }
      cursors.pop();
      continue;
    }
    const number = Number(choice);
    if (Number.isInteger(number) && number >= 1 && number <= page.items.length)
      return page.items[number - 1];
    const byId = page.items.filter(
      (item) => id(item).toLowerCase() === normalized,
    );
    if (byId.length === 1) return byId[0];
    throw new UsageError(
      `Select one displayed ${noun} number, UUID, next, back, or cancel.`,
    );
  }
}
function requireTask(value?: string): string {
  if (!value)
    throw new UsageError(
      "No active task. Use /enter, /tasks, /search, or /new.",
    );
  return value;
}
export function parseInteractiveLine(value: string): string[] {
  return (
    value
      .match(/(?:[^\s"]+|"[^"]*")+/g)
      ?.map((part) => part.replace(/^"|"$/g, "")) ?? []
  );
}

export function requireNextCursor(
  cursor: string | null | undefined,
  activeCursors: readonly (string | undefined)[],
): string {
  if (!cursor?.trim() || activeCursors.includes(cursor))
    throw new CliError(
      "The External API returned an invalid or repeated page cursor.",
      ExitCode.unavailable,
    );
  return cursor;
}

export class InteractiveForegroundOperation {
  private controller = new AbortController();

  public constructor(private readonly sessionSignal?: AbortSignal) {}

  public get signal(): AbortSignal {
    return this.sessionSignal
      ? AbortSignal.any([this.sessionSignal, this.controller.signal])
      : this.controller.signal;
  }

  public get sessionCancellationRequested(): boolean {
    return this.sessionSignal?.aborted ?? false;
  }

  public cancel(): void {
    this.controller.abort();
  }

  public renew(): AbortSignal {
    this.controller.abort();
    this.controller = new AbortController();
    return this.signal;
  }

  public dispose(): void {
    this.controller.abort();
  }
}

interface PendingInteractiveMutation {
  key: string;
  label: string;
  action: (key: string, signal: AbortSignal) => Promise<unknown>;
  accepted: (value: unknown, key: string, signal: AbortSignal) => Promise<void>;
}

export class InteractiveMutationCoordinator {
  private pending: PendingInteractiveMutation | undefined;

  public constructor(
    private readonly createKey: () => string = () => crypto.randomUUID(),
  ) {}

  public get hasPending(): boolean {
    return this.pending !== undefined;
  }

  public async execute<T>(
    label: string,
    action: (key: string, signal: AbortSignal) => Promise<T>,
    accepted: (value: T, key: string, signal: AbortSignal) => Promise<void>,
    signal: AbortSignal,
  ): Promise<void> {
    if (this.pending)
      throw new UsageError(
        `Replay the pending ${this.pending.label} with /retry before starting another mutation.`,
      );
    const operation: PendingInteractiveMutation = {
      key: this.createKey(),
      label,
      action,
      accepted: accepted as PendingInteractiveMutation["accepted"],
    };
    const value = await this.perform(operation, signal);
    await operation.accepted(value, operation.key, signal);
  }

  public async retry(
    signal: AbortSignal,
  ): Promise<{ key: string; label: string }> {
    if (!this.pending)
      throw new UsageError("There is no ambiguous mutation to replay.");
    const operation = this.pending;
    const value = await this.perform(operation, signal);
    await operation.accepted(value, operation.key, signal);
    return { key: operation.key, label: operation.label };
  }

  private async perform(
    operation: PendingInteractiveMutation,
    signal: AbortSignal,
  ): Promise<unknown> {
    try {
      const result = await operation.action(operation.key, signal);
      if (this.pending === operation) this.pending = undefined;
      return result;
    } catch (error) {
      if (
        error instanceof CliError &&
        (error.exitCode === ExitCode.unavailable ||
          error.exitCode === ExitCode.interrupted)
      ) {
        this.pending = operation;
        if (error.exitCode === ExitCode.interrupted) throw error;
        throw new CliError(
          `${error.message} The mutation outcome may be unknown. Use /retry to replay ${operation.label} with idempotency key ${operation.key}.`,
          error.exitCode,
          { cause: error },
        );
      }
      if (this.pending === operation) this.pending = undefined;
      throw error;
    }
  }
}

const pendingSafeCommands = new Set([
  "/retry",
  "/help",
  "/exit",
  "/clear",
  "/status",
  "/repos",
  "/agents",
  "/show",
  "/messages",
  "/message-search",
  "/events",
  "/wait",
  "/follow",
  "/open",
]);

export function isInteractiveCommandAllowedWhilePending(
  command: string | undefined,
): boolean {
  return command !== undefined && pendingSafeCommands.has(command);
}

async function ask(
  terminal: readline.Interface,
  signal: AbortSignal,
  prompt: string,
): Promise<string> {
  return await terminal.question(sanitizeInteractiveText(prompt), { signal });
}

export function sanitizeInteractiveText(value: string): string {
  return sanitize(value);
}

function writeInteractive(
  value: string,
  destination: "stdout" | "stderr" = "stdout",
): void {
  const terminated = value.endsWith("\n");
  const content = terminated ? value.slice(0, -1) : value;
  process[destination].write(
    `${sanitizeInteractiveText(content)}${terminated ? "\n" : ""}`,
  );
}

export function isInteractiveAbort(error: unknown): boolean {
  return (
    (error instanceof CliError && error.exitCode === ExitCode.interrupted) ||
    (error instanceof Error &&
      (error.name === "AbortError" || error.name === "TimeoutError"))
  );
}
function help(): void {
  for (const line of [
    "/workspaces  /workspace [id-or-name]  /repos  /agents",
    "/tasks  /search <query>  /enter [task-id]  /leave  /new",
    "/show  /messages  /message-search <query>  /events",
    "/send [--no-follow] <message>  /compose  /steer <message-id>",
    "/cancel  /suspend  /resume  /wait [seconds]  /follow  /open",
    "/status  /login  /logout  /environment",
    "/retry  /clear  /exit",
    "Any non-command line sends a follow-up to the active task and follows it.",
  ])
    writeInteractive(`${line}\n`);
}
