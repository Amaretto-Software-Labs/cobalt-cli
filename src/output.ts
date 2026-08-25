import type { CobaltEnvironment } from "./environment.js";
import { ApiError, ExitCode } from "./errors.js";

export type OutputMode = "human" | "json" | "jsonl";

export class Output {
  private kind: string | undefined;
  private value: unknown;
  private items: unknown[] | undefined;
  private idempotencyKey: string | undefined;
  private outcome: string | undefined;

  public constructor(
    private readonly environment: CobaltEnvironment,
    public readonly mode: OutputMode,
    private readonly quiet = false,
  ) {}

  public beginMutation(key: string): void {
    this.idempotencyKey = key;
  }

  public result(
    kind: string,
    value: unknown,
    key?: string,
    outcome?: string,
  ): void {
    if (this.mode === "json") {
      if (this.kind && this.kind !== kind)
        throw new Error("A JSON command must produce one result kind.");
      this.kind = kind;
      this.idempotencyKey ??= key;
      this.outcome ??= outcome;
      if (Array.isArray(value)) (this.items ??= []).push(...value);
      else if (this.value === undefined) this.value = value;
      else throw new Error("A JSON command must produce one result document.");
      return;
    }
    if (this.mode === "jsonl") {
      if (Array.isArray(value))
        for (const item of value) this.line(kind, item, key, outcome);
      else this.line(kind, value, key, outcome);
      return;
    }
    writeHuman(value);
  }

  public pageEnd(hasMore: boolean, nextCursor?: string | null): void {
    this.line("pageEnd", { hasMore, nextCursor: nextCursor ?? null });
  }
  public warning(message: string): void {
    if (this.mode === "human" && !this.quiet)
      process.stderr.write(`cobalt: warning: ${sanitize(message)}\n`);
  }

  public complete(): void {
    if (this.mode !== "json" || !this.kind) return;
    process.stdout.write(
      `${JSON.stringify({ apiVersion: "v1", kind: this.kind, environment: this.environment.name, data: this.items ?? this.value ?? null, meta: { requestId: null, idempotencyKey: this.idempotencyKey ?? null, idempotencyOutcome: this.outcome ?? null } })}\n`,
    );
  }

  public error(error: unknown, exitCode: number): void {
    const exception = error instanceof Error ? error : new Error(String(error));
    if (this.mode !== "human") {
      const payload =
        error instanceof ApiError
          ? {
              ...error.problem,
              environment: this.environment.name,
              exitCode,
              idempotencyKey: this.idempotencyKey ?? null,
            }
          : {
              type: `urn:cobaltcode:cli:${localCode(exitCode)}`,
              title: "Cobalt CLI error",
              status: localStatus(exitCode),
              detail: exception.message,
              code: localCode(exitCode),
              retryable: exitCode === ExitCode.unavailable,
              traceId: null,
              environment: this.environment.name,
              exitCode,
              idempotencyKey: this.idempotencyKey ?? null,
            };
      process.stderr.write(`${JSON.stringify(payload)}\n`);
    } else {
      process.stderr.write(`cobalt: ${sanitize(exception.message)}\n`);
      if (this.idempotencyKey && exitCode === ExitCode.unavailable)
        process.stderr.write(
          `cobalt: The mutation outcome may be unknown. Retry the same command with --idempotency-key ${sanitize(this.idempotencyKey)}.\n`,
        );
    }
  }

  private line(
    kind: string,
    data: unknown,
    key?: string,
    outcome?: string,
  ): void {
    const meta =
      key || outcome
        ? { idempotencyKey: key ?? null, idempotencyOutcome: outcome ?? null }
        : undefined;
    process.stdout.write(
      `${JSON.stringify({ apiVersion: "v1", kind, environment: this.environment.name, data, ...(meta ? { meta } : {}) })}\n`,
    );
  }
}

export function sanitize(value: string | undefined | null): string {
  return [...(value ?? "")]
    .map((character) => (/[\p{Cc}\p{Cf}]/u.test(character) ? "�" : character))
    .join("");
}

function writeHuman(value: unknown): void {
  if (value === undefined || value === null) return;
  if (Array.isArray(value)) {
    if (!value.length) process.stdout.write("No results found.\n");
    else for (const item of value) writeHuman(item);
    return;
  }
  if (typeof value === "string") {
    process.stdout.write(`${sanitize(value)}\n`);
    return;
  }
  if (typeof value !== "object") {
    process.stdout.write(`${String(value)}\n`);
    return;
  }
  const item = value as Record<string, unknown>;
  let line: string;
  if (typeof item.name === "string" && typeof item.role === "string")
    line = `${item.id}  ${item.name}  ${item.role}  members:${item.memberCount}`;
  else if (typeof item.displayName === "string")
    line = `${item.id}  ${item.displayName}  ${item.provider}  ${item.status}  eligible:${item.taskEligible}`;
  else if (typeof item.label === "string" && typeof item.agentKind === "string")
    line = `${item.id}  ${item.label}  ${item.agentKind}  ${item.status}${item.isDefault ? "  default" : ""}`;
  else if (typeof item.eventType === "string")
    line = `[${item.sequence}] ${item.eventType}  ${item.createdAt}`;
  else if (typeof item.author === "string" && "content" in item)
    line = `[${item.sequence}] ${item.author}: ${item.content}${item.contentTruncated ? " [truncated]" : ""}`;
  else if (
    typeof item.id === "string" &&
    typeof item.workspaceId === "string" &&
    Array.isArray(item.actions)
  )
    line = `Task: ${item.id}\nTitle: ${item.title}\nStatus: ${item.status}\nWorkspace: ${item.workspaceId}\nAgent: ${item.agentKind ?? ""} ${item.model ?? ""}\nActions: ${item.actions.join(", ")}`;
  else if (
    typeof item.title === "string" &&
    typeof item.status === "string" &&
    typeof item.id === "string"
  )
    line = `${item.id}  ${item.status}  ${item.title}`;
  else if (
    typeof item.taskId === "string" &&
    typeof item.title === "string" &&
    typeof item.repository === "string"
  )
    line = `${item.taskId}  ${item.status}  ${item.title}  ${item.repository}`;
  else if (
    typeof item.messageId === "string" &&
    typeof item.taskTitle === "string" &&
    Array.isArray(item.excerpt)
  )
    line = `${item.taskId}/${item.messageId}  ${item.taskTitle}  ${item.excerpt
      .map((part) =>
        typeof part === "object" && part && "text" in part
          ? String(part.text)
          : "",
      )
      .join("")}`;
  else line = JSON.stringify(value, null, 2);
  process.stdout.write(`${sanitize(line)}\n`);
}

function localStatus(code: number): number {
  return (
    (
      {
        [ExitCode.usage]: 400,
        [ExitCode.authentication]: 401,
        [ExitCode.authorization]: 403,
        [ExitCode.notFound]: 404,
        [ExitCode.conflict]: 409,
        [ExitCode.rateLimited]: 429,
        [ExitCode.unavailable]: 503,
        [ExitCode.admission]: 402,
        [ExitCode.interrupted]: 499,
      } as Record<number, number>
    )[code] ?? 500
  );
}

function localCode(code: number): string {
  return (
    (
      {
        [ExitCode.usage]: "cli_usage",
        [ExitCode.authentication]: "cli_authentication",
        [ExitCode.authorization]: "cli_authorization",
        [ExitCode.notFound]: "cli_not_found",
        [ExitCode.conflict]: "cli_conflict",
        [ExitCode.rateLimited]: "cli_rate_limited",
        [ExitCode.unavailable]: "cli_unavailable",
        [ExitCode.admission]: "cli_admission",
        [ExitCode.configuration]: "cli_configuration",
        [ExitCode.interrupted]: "cli_interrupted",
      } as Record<number, string>
    )[code] ?? "cli_error"
  );
}
