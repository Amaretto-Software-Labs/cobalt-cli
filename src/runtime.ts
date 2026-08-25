import {
  CobaltApiClient,
  validId,
  type Agent,
  type Repository,
  type Workspace,
} from "./api.js";
import { TokenProvider } from "./auth.js";
import { ConfigStore, type CliConfig } from "./config.js";
import type { CredentialStore } from "./credential-store.js";
import { resolveEnvironment, type CobaltEnvironment } from "./environment.js";
import { CliError, ExitCode, UsageError } from "./errors.js";
import { Output, type OutputMode } from "./output.js";

export interface GlobalOptions {
  environment?: string;
  workspace?: string;
  json?: boolean;
  jsonl?: boolean;
  quiet?: boolean;
  trace?: boolean;
  idempotencyKey?: string;
}

export interface Context {
  environment: CobaltEnvironment;
  config: CliConfig;
  configStore: ConfigStore;
  credentialStore: CredentialStore;
  tokenProvider: TokenProvider;
  api: CobaltApiClient;
  output: Output;
  workspaceId?: string;
  workspaceName?: string;
  requireWorkspace(): string;
}

export class Runtime {
  public constructor(
    private readonly configStore: ConfigStore,
    private readonly credentialStore: CredentialStore,
  ) {}

  public async context(
    options: GlobalOptions,
    scopes: readonly string[],
    resolveWorkspace = true,
  ): Promise<Context> {
    if (options.json && options.jsonl)
      throw new UsageError("--json and --jsonl are mutually exclusive.");
    const config = await this.configStore.load();
    const environment = resolveEnvironment(
      options.environment ??
        process.env.COBALT_ENVIRONMENT ??
        config.currentEnvironment,
    );
    const mode: OutputMode = options.json
      ? "json"
      : options.jsonl
        ? "jsonl"
        : "human";
    const output = new Output(environment, mode, options.quiet);
    const tokenProvider = new TokenProvider(environment, this.credentialStore);
    await tokenProvider.preflight(scopes);
    const api = new CobaltApiClient(environment, tokenProvider, options.trace);
    let workspaceId: string | undefined;
    let workspaceName: string | undefined;
    if (resolveWorkspace) {
      const workspaceReference =
        options.workspace ?? process.env.COBALT_WORKSPACE;
      if (workspaceReference) {
        const workspace = await resolveWorkspaceItem(api, workspaceReference);
        workspaceId = workspace.id;
        workspaceName = workspace.name;
      } else {
        workspaceId = config.environments[environment.name]?.workspaceId;
        workspaceName = config.environments[environment.name]?.workspaceName;
      }
    }
    const context: Context = {
      environment,
      config,
      configStore: this.configStore,
      credentialStore: this.credentialStore,
      tokenProvider,
      api,
      output,
      ...(workspaceId ? { workspaceId } : {}),
      ...(workspaceName ? { workspaceName } : {}),
      requireWorkspace: () => {
        if (!context.workspaceId)
          throw new UsageError(
            "A workspace is required. Run 'cobalt workspace use <workspace>' or pass --workspace.",
          );
        return context.workspaceId;
      },
    };
    return context;
  }
}

export interface PageLike<T> {
  items: T[];
  hasMore: boolean;
  nextCursor?: string | null | undefined;
}
export async function allPages<T>(
  load: (cursor?: string) => Promise<PageLike<T>>,
  all: boolean,
  emit: (items: T[], page: PageLike<T>) => void,
): Promise<void> {
  let cursor: string | undefined;
  const seen = new Set<string>();
  do {
    const page = await load(cursor);
    emit(page.items, page);
    if (!all || !page.hasMore) return;
    if (!page.nextCursor || seen.has(page.nextCursor))
      throw new CliError(
        "The External API returned an invalid or repeated page cursor.",
        ExitCode.unavailable,
      );
    seen.add(page.nextCursor);
    cursor = page.nextCursor;
  } while (cursor);
}

export async function resolveWorkspaceItem(
  api: CobaltApiClient,
  reference: string,
  signal?: AbortSignal,
): Promise<Workspace> {
  return await resolvePaged(
    reference,
    (cursor) => api.listWorkspaces(100, cursor, signal),
    (item) => item.name,
    "Workspace",
    true,
  );
}

export async function resolveRepositoryItem(
  api: CobaltApiClient,
  workspaceId: string,
  reference: string,
  signal?: AbortSignal,
): Promise<Repository> {
  return await resolvePaged(
    reference,
    (cursor) => api.listRepositories(workspaceId, 100, cursor, signal),
    (item) => item.displayName,
    "Repository",
  );
}

export async function resolveAgent(
  api: CobaltApiClient,
  workspaceId: string,
  reference?: string,
  model?: string,
  reasoning?: string,
  signal?: AbortSignal,
): Promise<{ accountId: string; model?: string; reasoningEffort?: string }> {
  const accounts: Agent[] = [];
  await allPages(
    (cursor) => api.listAgents(workspaceId, 100, cursor, signal),
    true,
    (items) => accounts.push(...items),
  );
  let account: Agent | undefined;
  if (!reference) {
    const defaults = accounts.filter(
      (item) => item.status === "ready" && item.isDefault,
    );
    if (defaults.length !== 1)
      throw new CliError(
        "Select an agent account with --agent.",
        ExitCode.conflict,
      );
    account = defaults[0];
  } else {
    const matches = accounts.filter(
      (item) =>
        item.id.toLowerCase() === reference.toLowerCase() ||
        item.label.toLowerCase() === reference.toLowerCase(),
    );
    if (!matches.length)
      throw new CliError(
        `Agent '${reference}' was not found.`,
        ExitCode.notFound,
      );
    if (matches.length > 1)
      throw new CliError(
        `Agent '${reference}' is ambiguous; use its UUID.`,
        ExitCode.conflict,
      );
    account = matches[0];
  }
  if (!account || account.status !== "ready")
    throw new CliError(
      "The selected agent account is not ready.",
      ExitCode.conflict,
    );
  const selectedModel = model
    ? account.models.find((item) => item.id === model)
    : undefined;
  if (model && !selectedModel)
    throw new UsageError(
      "The selected model is not advertised by this account.",
    );
  const reasoningModel =
    selectedModel ??
    (reasoning
      ? account.models.find((item) => item.id === account.defaultModel)
      : undefined);
  if (reasoning && !reasoningModel?.reasoningEfforts.includes(reasoning))
    throw new UsageError(
      "The selected reasoning effort is not advertised by the selected or default model.",
    );
  return {
    accountId: account.id,
    ...(model ? { model } : {}),
    ...(reasoning ? { reasoningEffort: reasoning } : {}),
  };
}

async function resolvePaged<T extends { id: string }>(
  reference: string,
  load: (cursor?: string) => Promise<PageLike<T>>,
  name: (item: T) => string,
  noun: string,
  uuidIsExclusive = false,
): Promise<T> {
  let parsedId: string | undefined;
  try {
    parsedId = validId(reference);
  } catch {
    // A non-UUID reference is resolved only as an exact, case-insensitive name.
  }
  const matches: T[] = [];
  await allPages(load, true, (items) =>
    matches.push(
      ...items.filter(
        (item) =>
          item.id.toLowerCase() === reference.toLowerCase() ||
          ((!uuidIsExclusive || !parsedId) &&
            name(item).toLowerCase() === reference.toLowerCase()),
      ),
    ),
  );
  if (!matches.length)
    throw new CliError(
      `${noun} '${reference}' was not found.`,
      ExitCode.notFound,
    );
  if (matches.length > 1)
    throw new CliError(
      `${noun} '${reference}' is ambiguous; use its UUID.`,
      ExitCode.conflict,
    );
  return matches[0]!;
}
