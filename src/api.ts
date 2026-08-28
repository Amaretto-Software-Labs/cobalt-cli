import { z } from "zod";
import { setTimeout as sleep } from "node:timers/promises";
import type { TokenProvider } from "./auth.js";
import type { CobaltEnvironment } from "./environment.js";
import { ApiError, CliError, ExitCode, type ProblemDetails } from "./errors.js";
import {
  readBoundedBytes,
  ResponseReadError,
  trackResponseForegroundSignal,
} from "./http.js";
import { packageVersion } from "./version.js";

const guid = z.guid();
const sequence = z.union([
  z.number().int().nonnegative().safe(),
  z
    .string()
    .regex(/^\d+$/)
    .transform(Number)
    .pipe(z.number().int().nonnegative().safe()),
]);
const entity = z.looseObject({ id: guid });
export const workspaceSchema = entity.extend({
  name: z.string(),
  role: z.string(),
  memberCount: z.number().int(),
});
export const repositorySchema = entity.extend({
  displayName: z.string(),
  provider: z.string(),
  status: z.string(),
  taskEligible: z.boolean(),
});
export const modelSchema = z.looseObject({
  id: z.string(),
  label: z.string(),
  reasoningEfforts: z.array(z.string()),
  defaultReasoningEffort: z.string().nullable().optional(),
});
export const agentSchema = entity.extend({
  label: z.string(),
  agentKind: z.string(),
  status: z.string(),
  isDefault: z.boolean(),
  defaultModel: z.string().nullable().optional(),
  models: z.array(modelSchema),
});
export const taskSummarySchema = entity.extend({
  title: z.string(),
  status: z.string(),
  lastEventSequence: sequence,
});
export const taskDetailSchema = taskSummarySchema.extend({
  workspaceId: guid,
  lastEventSequence: sequence,
  actions: z.array(z.string()).default([]),
});
export const messageSchema = z.looseObject({
  messageId: guid,
  sequence,
  author: z.string(),
  content: z.string(),
  contentTruncated: z.boolean(),
});
export const eventSchema = z.looseObject({
  sequence,
  eventType: z.string(),
  createdAt: z.string(),
});
export const taskEventPageSchema = z.looseObject({
  items: z.array(eventSchema),
  hasMore: z.boolean(),
});
export const pageSchema = <T extends z.ZodType>(item: T) =>
  z.looseObject({
    items: z.array(item),
    hasMore: z.boolean(),
    nextCursor: z.string().nullable().optional(),
  });
const taskSearchSchema = z.looseObject({
  taskId: guid,
  title: z.string(),
  repository: z.string(),
  status: z.string(),
  visibility: z.string(),
  targetView: z.string(),
  lastActivityAt: z.string(),
});
const messageSearchSchema = z.looseObject({
  messageId: guid,
  taskId: guid,
  taskTitle: z.string(),
  targetView: z.string(),
  role: z.string(),
  author: z.string(),
  createdAt: z.string(),
  repository: z.string(),
  excerpt: z.array(z.looseObject({ text: z.string() })),
});
const createTaskResponseSchema = z.looseObject({
  taskId: guid,
  status: z.string(),
  operationInProgress: z.boolean(),
  lastEventSequence: sequence,
  acceptedAt: z.string(),
});
const sendMessageResponseSchema = z.looseObject({
  taskId: guid,
  messageId: guid,
  sequence,
  status: z.string(),
  createdAt: z.string(),
  lastEventSequence: sequence,
});
const steerResponseSchema = z.looseObject({
  taskId: guid,
  messageId: guid,
  status: z.string(),
});
const cancelResponseSchema = z.looseObject({
  taskId: guid,
  status: z.string(),
  partialChangesMayRemain: z.boolean(),
  lastEventSequence: sequence,
  acceptedAt: z.string(),
});
const lifecycleResponseSchema = z.looseObject({
  taskId: guid,
  status: z.string(),
  operationInProgress: z.boolean(),
  lastEventSequence: sequence,
  acceptedAt: z.string(),
});
const waitResponseSchema = z.looseObject({
  timedOut: z.boolean(),
  tasks: z.array(
    z.looseObject({
      taskId: guid,
      status: z.string(),
      lastEventSequence: sequence,
      nextAfterSequence: sequence,
      events: z.array(eventSchema),
    }),
  ),
});
const problemSchema = z.object({
  type: z.string().min(1),
  title: z.string().min(1),
  status: z.number().int(),
  detail: z.string().min(1),
  code: z.string().min(1),
  retryable: z.boolean(),
  traceId: z.string(),
  details: z.record(z.string(), z.unknown()),
});

export interface MutationResult<T> {
  value: T;
  status: number;
  outcome?: string;
  location?: string;
}
export interface Page<T> {
  items: T[];
  hasMore: boolean;
  nextCursor?: string | null | undefined;
}
export type Workspace = z.infer<typeof workspaceSchema>;
export type Repository = z.infer<typeof repositorySchema>;
export type Agent = z.infer<typeof agentSchema>;
export type TaskSummary = z.infer<typeof taskSummarySchema>;
export type TaskDetail = z.infer<typeof taskDetailSchema>;
export type TaskEvent = z.infer<typeof eventSchema>;

export class CobaltApiClient {
  public constructor(
    private readonly environment: CobaltEnvironment,
    private readonly tokens: TokenProvider,
    private readonly trace = false,
  ) {
    if (
      environment.apiBase.protocol !== "https:" ||
      environment.apiBase.pathname.replace(/\/$/, "") !== "/v1"
    )
      throw new Error("External API base URL must be HTTPS and end in /v1.");
  }

  public listWorkspaces(
    limit = 100,
    cursor?: string,
    signal?: AbortSignal,
  ): Promise<Page<Workspace>> {
    return this.request(
      "GET",
      withQuery("workspaces", { limit, cursor }),
      pageSchema(workspaceSchema),
      undefined,
      signal,
    );
  }
  public listRepositories(
    workspaceId: string,
    limit = 100,
    cursor?: string,
    signal?: AbortSignal,
  ): Promise<Page<Repository>> {
    return this.request(
      "GET",
      withQuery(`workspaces/${validId(workspaceId)}/repositories`, {
        limit,
        cursor,
      }),
      pageSchema(repositorySchema),
      undefined,
      signal,
    );
  }
  public listAgents(
    workspaceId?: string,
    limit = 100,
    cursor?: string,
    signal?: AbortSignal,
  ): Promise<Page<Agent>> {
    return this.request(
      "GET",
      withQuery("agent-accounts", { workspaceId, limit, cursor }),
      pageSchema(agentSchema),
      undefined,
      signal,
    );
  }
  public listTasks(
    workspaceId: string,
    query: {
      status?: string[];
      repositoryId?: string;
      createdByMe?: boolean;
      limit?: number;
      cursor?: string;
    },
    signal?: AbortSignal,
  ): Promise<Page<TaskSummary>> {
    return this.request(
      "GET",
      withQuery(`workspaces/${validId(workspaceId)}/tasks`, query),
      pageSchema(taskSummarySchema),
      undefined,
      signal,
    );
  }
  public searchTasks(
    workspaceId: string,
    body: object,
    signal?: AbortSignal,
  ): Promise<Page<z.infer<typeof taskSearchSchema>>> {
    return this.request(
      "POST",
      `workspaces/${validId(workspaceId)}/tasks/search`,
      pageSchema(taskSearchSchema),
      body,
      signal,
    );
  }
  public searchMessages(
    workspaceId: string,
    body: object,
    signal?: AbortSignal,
  ): Promise<Page<z.infer<typeof messageSearchSchema>>> {
    return this.request(
      "POST",
      `workspaces/${validId(workspaceId)}/task-messages/search`,
      pageSchema(messageSearchSchema),
      body,
      signal,
    );
  }
  public getTask(taskId: string, signal?: AbortSignal): Promise<TaskDetail> {
    return this.request(
      "GET",
      `tasks/${validId(taskId)}`,
      taskDetailSchema,
      undefined,
      signal,
    );
  }
  public listMessages(
    taskId: string,
    limit = 100,
    cursor?: string,
    signal?: AbortSignal,
  ): Promise<Page<z.infer<typeof messageSchema>>> {
    return this.request(
      "GET",
      withQuery(`tasks/${validId(taskId)}/messages`, { limit, cursor }),
      pageSchema(messageSchema),
      undefined,
      signal,
    );
  }
  public listEvents(
    taskId: string,
    afterSequence = 0,
    limit = 100,
    signal?: AbortSignal,
  ): Promise<z.infer<typeof taskEventPageSchema>> {
    return this.request(
      "GET",
      withQuery(`tasks/${validId(taskId)}/events`, { afterSequence, limit }),
      taskEventPageSchema,
      undefined,
      signal,
    );
  }
  public createTask(
    workspaceId: string,
    body: object,
    key: string,
    signal?: AbortSignal,
  ): Promise<MutationResult<z.infer<typeof createTaskResponseSchema>>> {
    return this.mutate(
      `workspaces/${validId(workspaceId)}/tasks`,
      body,
      key,
      createTaskResponseSchema,
      signal,
    );
  }
  public sendMessage(
    taskId: string,
    body: object,
    key: string,
    signal?: AbortSignal,
  ): Promise<MutationResult<z.infer<typeof sendMessageResponseSchema>>> {
    return this.mutate(
      `tasks/${validId(taskId)}/messages`,
      body,
      key,
      sendMessageResponseSchema,
      signal,
    );
  }
  public steerMessage(
    taskId: string,
    messageId: string,
    key: string,
    signal?: AbortSignal,
  ): Promise<MutationResult<z.infer<typeof steerResponseSchema>>> {
    return this.mutate(
      `tasks/${validId(taskId)}/messages/${validId(messageId)}/steer`,
      {},
      key,
      steerResponseSchema,
      signal,
    );
  }
  public cancelTurn(
    taskId: string,
    key: string,
    signal?: AbortSignal,
  ): Promise<MutationResult<z.infer<typeof cancelResponseSchema>>> {
    return this.mutate(
      `tasks/${validId(taskId)}/turn/cancel`,
      {},
      key,
      cancelResponseSchema,
      signal,
    );
  }
  public suspendTask(
    taskId: string,
    key: string,
    signal?: AbortSignal,
  ): Promise<MutationResult<z.infer<typeof lifecycleResponseSchema>>> {
    return this.mutate(
      `tasks/${validId(taskId)}/suspend`,
      {},
      key,
      lifecycleResponseSchema,
      signal,
    );
  }
  public resumeTask(
    taskId: string,
    body: object,
    key: string,
    signal?: AbortSignal,
  ): Promise<MutationResult<z.infer<typeof lifecycleResponseSchema>>> {
    return this.mutate(
      `tasks/${validId(taskId)}/resume`,
      body,
      key,
      lifecycleResponseSchema,
      signal,
    );
  }
  public deleteTask(
    taskId: string,
    key: string,
    signal?: AbortSignal,
  ): Promise<MutationResult<z.infer<typeof lifecycleResponseSchema>>> {
    return this.mutate(
      `tasks/${validId(taskId)}`,
      undefined,
      key,
      lifecycleResponseSchema,
      signal,
      "DELETE",
    );
  }
  public waitForTasks(
    body: object,
    signal?: AbortSignal,
  ): Promise<z.infer<typeof waitResponseSchema>> {
    return this.request("POST", "tasks/wait", waitResponseSchema, body, signal);
  }

  private async mutate<T>(
    path: string,
    body: object | undefined,
    key: string,
    schema: z.ZodType<T>,
    signal?: AbortSignal,
    method = "POST",
  ): Promise<MutationResult<T>> {
    validId(key);
    const response = await this.send(
      method,
      path,
      body,
      { "idempotency-key": key },
      signal,
    );
    const value = await readJson(response, schema, 1024 * 1024);
    const outcome =
      response.headers.get("cobalt-idempotency-outcome") ?? undefined;
    const location = response.headers.get("location") ?? undefined;
    return {
      value,
      status: response.status,
      ...(outcome ? { outcome } : {}),
      ...(location ? { location } : {}),
    };
  }

  private async request<T>(
    method: string,
    path: string,
    schema: z.ZodType<T>,
    body?: object,
    signal?: AbortSignal,
  ): Promise<T> {
    const response = await this.send(method, path, body, {}, signal);
    return await readJson(response, schema, 1024 * 1024);
  }

  private async send(
    method: string,
    path: string,
    body?: object,
    extraHeaders: Record<string, string> = {},
    signal?: AbortSignal,
  ): Promise<Response> {
    const started = Date.now();
    let token = await this.tokens.getAccessToken(signal);
    let refreshed = false;
    const retryAllowed = path !== "tasks/wait";
    for (let attempt = 1; ; attempt++) {
      const url = new URL(
        path,
        `${this.environment.apiBase.toString().replace(/\/$/, "")}/`,
      );
      const headers: Record<string, string> = {
        accept: "application/json",
        authorization: `Bearer ${token}`,
        "user-agent": `cobalt-cli/${packageVersion()}`,
        ...extraHeaders,
      };
      if (body !== undefined) headers["content-type"] = "application/json";
      if (this.trace)
        process.stderr.write(
          `cobalt: trace: ${method} ${url.origin}${url.pathname} attempt=${attempt}\n`,
        );
      let response: Response;
      try {
        const timeoutSignal = AbortSignal.timeout(45_000);
        const requestSignal = signal
          ? AbortSignal.any([signal, timeoutSignal])
          : timeoutSignal;
        response = await fetch(url, {
          method,
          redirect: "error",
          headers,
          signal: requestSignal,
          ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
        });
        trackResponseForegroundSignal(response, signal);
      } catch (error) {
        if (signal?.aborted)
          throw new CliError(
            "The External API request was interrupted.",
            ExitCode.interrupted,
            { cause: error },
          );
        if (retryAllowed && attempt < 4 && Date.now() - started < 30_000) {
          await delay(backoff(attempt), signal);
          continue;
        }
        throw new CliError(
          "The External API is unavailable after the retry budget.",
          ExitCode.unavailable,
          { cause: error },
        );
      }
      if (
        response.status === 401 &&
        !refreshed &&
        !this.tokens.usesEnvironmentToken()
      ) {
        token = await this.tokens.refreshAfterUnauthorized(signal);
        refreshed = true;
        continue;
      }
      if (response.ok) return response;
      const problem = await readProblem(response);
      if (
        retryAllowed &&
        attempt < 4 &&
        Date.now() - started < 30_000 &&
        (response.status === 429 ||
          response.status === 503 ||
          problem.retryable)
      ) {
        const retryAfter = retryAfterMs(response);
        await delay(Math.min(retryAfter ?? backoff(attempt), 10_000), signal);
        continue;
      }
      if (response.status === 401 && !this.tokens.usesEnvironmentToken())
        await this.tokens.invalidate();
      throw new ApiError(problem, retryAfterMs(response));
    }
  }
}

async function readJson<T>(
  response: Response,
  schema: z.ZodType<T>,
  maximum: number,
): Promise<T> {
  const contentType = response.headers
    .get("content-type")
    ?.split(";", 1)[0]
    ?.trim()
    .toLowerCase();
  if (contentType !== "application/json" && !contentType?.endsWith("+json"))
    throw new CliError(
      "The External API response did not use a JSON content type.",
      ExitCode.unavailable,
    );
  const declared = Number(response.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > maximum)
    throw new CliError(
      "The External API response exceeded the allowed size.",
      ExitCode.unavailable,
    );
  let bytes: Uint8Array;
  try {
    bytes = await readBoundedBytes(response, maximum);
  } catch (error) {
    if (error instanceof ResponseReadError)
      throw new CliError(
        error.interrupted
          ? "The External API response was interrupted."
          : "The External API response transport failed.",
        error.interrupted ? ExitCode.interrupted : ExitCode.unavailable,
        { cause: error },
      );
    throw new CliError(
      "The External API response exceeded the allowed size.",
      ExitCode.unavailable,
      { cause: error },
    );
  }
  if (!bytes.length || bytes.length > maximum)
    throw new CliError(
      "The External API returned an invalid response size.",
      ExitCode.unavailable,
    );
  try {
    return schema.parse(
      JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)),
    );
  } catch (error) {
    throw new CliError(
      "The External API returned an invalid JSON response.",
      ExitCode.unavailable,
      { cause: error },
    );
  }
}

async function readProblem(response: Response): Promise<ProblemDetails> {
  try {
    const parsed = await readJson(response, problemSchema, 64 * 1024);
    if (parsed.status !== response.status) throw new Error("status mismatch");
    return parsed;
  } catch (error) {
    if (error instanceof CliError && error.cause instanceof ResponseReadError)
      throw error;
    return {
      type: "urn:cobaltcode:problem:invalid_problem_details",
      title: "External API request failed",
      status: response.status,
      detail: "The External API returned an invalid error response.",
      code: "invalid_problem_details",
      retryable: response.status >= 500,
      traceId: "",
      details: {},
    };
  }
}

function withQuery(path: string, values: Record<string, unknown>): string {
  const query = new URLSearchParams();
  for (const [key, raw] of Object.entries(values)) {
    if (raw === undefined || raw === null || raw === false) continue;
    for (const value of Array.isArray(raw) ? raw : [raw])
      query.append(key, String(value));
  }
  return query.size ? `${path}?${query.toString()}` : path;
}

export function validId(value: string): string {
  if (
    !guid.safeParse(value).success ||
    /^00000000-0000-0000-0000-000000000000$/i.test(value)
  )
    throw new CliError("ID must be a non-empty UUID.", ExitCode.usage);
  return value.toLowerCase();
}

function retryAfterMs(response: Response): number | undefined {
  const raw = response.headers.get("retry-after");
  if (!raw) return undefined;
  const seconds = Number(raw);
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
  const date = Date.parse(raw);
  return Number.isNaN(date) ? undefined : Math.max(0, date - Date.now());
}

function backoff(attempt: number): number {
  return 250 * 2 ** (attempt - 1) + Math.random() * 250;
}
async function delay(
  milliseconds: number,
  signal?: AbortSignal,
): Promise<void> {
  try {
    await sleep(milliseconds, undefined, { signal });
  } catch (error) {
    if (signal?.aborted)
      throw new CliError(
        "The External API request was interrupted.",
        ExitCode.interrupted,
        { cause: error },
      );
    throw error;
  }
}
