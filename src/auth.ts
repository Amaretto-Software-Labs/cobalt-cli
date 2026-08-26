import crypto from "node:crypto";
import http from "node:http";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import {
  createLocalJWKSet,
  decodeJwt,
  jwtVerify,
  type JSONWebKeySet,
} from "jose";
import { z } from "zod";
import type { CredentialStore } from "./credential-store.js";
import type { CobaltEnvironment } from "./environment.js";
import { CliError, ConfigurationError, ExitCode } from "./errors.js";
import {
  readBoundedBytes,
  ResponseReadError,
  trackResponseForegroundSignal,
} from "./http.js";

const execFileAsync = promisify(execFile);
const sessionSchema = z.strictObject({
  refreshToken: z.string().min(1),
  subject: z.string().min(1),
  scope: z.string().min(1),
  savedAt: z.string().datetime(),
});
const discoverySchema = z.object({
  issuer: z.string().url(),
  authorization_endpoint: z.string().url(),
  token_endpoint: z.string().url(),
  jwks_uri: z.string().url(),
  revocation_endpoint: z.string().url().optional(),
});
const tokenSchema = z.object({
  access_token: z.string().min(1),
  refresh_token: z.string().min(1).optional(),
  expires_in: z.number().int().positive(),
  scope: z.string().optional(),
  id_token: z.string().min(1).optional(),
});
const identityRequestTimeoutMs = 30_000;

function oauthCallbackPage(success: boolean): string {
  const status = success ? "success" : "error";
  const title = success ? "Authorization complete" : "Authorization failed";
  const heading = success ? "You're connected" : "Sign-in wasn't completed";
  const description = success
    ? "Cobalt CLI received your authorization and is finishing sign-in in the terminal."
    : "Return to your terminal for details, then run the login command again to retry.";
  const command = success ? "cobalt auth status" : "cobalt auth login";
  const statusLabel = success
    ? "Secure authorization complete"
    : "Authorization needs attention";

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="color-scheme" content="dark light">
  <title>${title} · Cobalt CLI</title>
  <style>
    :root {
      color-scheme: dark;
      --bg: #09090b;
      --panel: #18181b;
      --panel-elevated: #1f1f23;
      --border: #27272a;
      --text: #d4d4d8;
      --text-muted: #a1a1aa;
      --text-bright: #fafafa;
      --accent: #22d3ee;
      --accent-hover: #06b6d4;
      --accent-contrast: #083344;
      --success: #22c55e;
      --error: #ef4444;
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Arial, sans-serif;
    }

    * { box-sizing: border-box; }

    body {
      min-height: 100vh;
      margin: 0;
      display: grid;
      place-items: center;
      padding: 24px;
      overflow: hidden;
      background:
        radial-gradient(circle at 12% 5%, rgb(34 211 238 / 18%), transparent 34%),
        radial-gradient(circle at 88% 18%, rgb(56 189 248 / 15%), transparent 31%),
        var(--bg);
      color: var(--text);
      font-size: 14px;
      line-height: 1.6;
      text-rendering: optimizeLegibility;
    }

    .glow {
      position: fixed;
      width: 340px;
      height: 340px;
      border-radius: 999px;
      background: rgb(34 211 238 / 8%);
      filter: blur(72px);
      pointer-events: none;
    }

    .glow-one { top: -180px; left: -120px; }
    .glow-two { right: -180px; bottom: -220px; }

    .card {
      position: relative;
      width: min(100%, 480px);
      overflow: hidden;
      border: 1px solid var(--border);
      border-radius: 12px;
      background: rgb(24 24 27 / 92%);
      box-shadow: 0 24px 72px rgb(0 0 0 / 42%);
      backdrop-filter: blur(18px);
    }

    .accent-line {
      height: 2px;
      background: linear-gradient(90deg, transparent, var(--accent), transparent);
    }

    .content { padding: 32px; }

    .brand {
      display: flex;
      align-items: center;
      gap: 11px;
      margin-bottom: 34px;
      color: var(--text-bright);
      font-size: 15px;
      font-weight: 650;
      letter-spacing: -0.01em;
    }

    .logo { width: 30px; height: 30px; flex: none; }

    .cli-label {
      margin-left: 2px;
      padding-left: 11px;
      border-left: 1px solid var(--border);
      color: var(--text-muted);
      font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
      font-size: 12px;
      font-weight: 500;
    }

    .status-icon {
      display: grid;
      width: 48px;
      height: 48px;
      place-items: center;
      margin-bottom: 22px;
      border: 1px solid var(--border);
      border: 1px solid color-mix(in srgb, var(--status-color) 32%, transparent);
      border-radius: 12px;
      background: var(--panel-elevated);
      background: color-mix(in srgb, var(--status-color) 12%, transparent);
      color: var(--status-color);
      box-shadow: 0 0 32px color-mix(in srgb, var(--status-color) 12%, transparent);
    }

    [data-status="success"] { --status-color: var(--success); }
    [data-status="error"] { --status-color: var(--error); }

    h1 {
      margin: 0 0 10px;
      color: var(--text-bright);
      font-size: clamp(24px, 7vw, 30px);
      line-height: 1.2;
      letter-spacing: -0.035em;
    }

    .description { margin: 0; color: var(--text-muted); }

    .terminal {
      display: flex;
      align-items: center;
      gap: 10px;
      margin-top: 27px;
      padding: 12px 14px;
      border: 1px solid var(--border);
      border-radius: 8px;
      background: var(--bg);
      color: var(--text);
      font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
      font-size: 12px;
      overflow-wrap: anywhere;
    }

    .prompt { color: var(--accent); user-select: none; }

    .footer {
      display: flex;
      align-items: center;
      gap: 8px;
      margin-top: 27px;
      padding-top: 20px;
      border-top: 1px solid var(--border);
      color: var(--text-muted);
      font-size: 12px;
    }

    .status-dot {
      width: 7px;
      height: 7px;
      flex: none;
      border-radius: 999px;
      background: var(--status-color);
      box-shadow: 0 0 10px color-mix(in srgb, var(--status-color) 70%, transparent);
    }

    @media (prefers-color-scheme: light) {
      :root {
        color-scheme: light;
        --bg: #f8fafc;
        --panel: #ffffff;
        --panel-elevated: #ffffff;
        --border: #cbd5e1;
        --text: #0f172a;
        --text-muted: #475569;
        --text-bright: #020617;
        --success: #15803d;
        --error: #b91c1c;
      }

      body {
        background:
          radial-gradient(circle at 12% 5%, rgb(34 211 238 / 17%), transparent 34%),
          radial-gradient(circle at 88% 18%, rgb(56 189 248 / 12%), transparent 31%),
          var(--bg);
      }

      .card {
        background: rgb(255 255 255 / 94%);
        box-shadow: 0 24px 72px rgb(15 23 42 / 14%);
      }

      .terminal { background: #f1f5f9; }
    }

    @media (max-width: 520px) {
      body { padding: 16px; }
      .content { padding: 26px 22px; }
      .brand { margin-bottom: 28px; }
    }

    @media (prefers-reduced-motion: no-preference) {
      .card { animation: arrive 360ms ease-out both; }
      .status-icon { animation: settle 420ms 100ms ease-out both; }

      @keyframes arrive {
        from { opacity: 0; transform: translateY(10px) scale(0.985); }
        to { opacity: 1; transform: translateY(0) scale(1); }
      }

      @keyframes settle {
        from { opacity: 0; transform: scale(0.82); }
        to { opacity: 1; transform: scale(1); }
      }
    }
  </style>
</head>
<body data-status="${status}">
  <div class="glow glow-one" aria-hidden="true"></div>
  <div class="glow glow-two" aria-hidden="true"></div>
  <main class="card" aria-labelledby="page-title">
    <div class="accent-line" aria-hidden="true"></div>
    <div class="content">
      <header class="brand">
        <svg class="logo" viewBox="0 0 49 48" role="img" aria-label="Cobalt">
          <path d="M1.984 29.29a17.21 17.21 0 0 1 17.21-17.21v17.21H1.984Z" fill="#0f766e"/>
          <path d="M1.984 29.29A17.21 17.21 0 0 0 19.194 46.5V29.29H1.984Z" fill="#14b8a6"/>
          <path d="M36.404 29.29A17.21 17.21 0 0 1 19.194 46.5V29.29h17.21Z" fill="#5eead4"/>
          <path d="M47.016 14.422a12.922 12.922 0 0 1-12.922 12.922H21.172V14.422a12.922 12.922 0 1 1 25.844 0Z" fill="#22d3ee"/>
        </svg>
        <span>Cobalt</span>
        <span class="cli-label">CLI</span>
      </header>

      <div class="status-icon" aria-hidden="true">
        ${
          success
            ? '<svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.25" stroke-linecap="round" stroke-linejoin="round"><path d="m5 12 4 4L19 6"/></svg>'
            : '<svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.25" stroke-linecap="round"><path d="M12 8v5"/><path d="M12 17.01v.01"/><circle cx="12" cy="12" r="9"/></svg>'
        }
      </div>
      <h1 id="page-title">${heading}</h1>
      <p class="description">${description}</p>

      <div class="terminal" aria-label="Suggested terminal command">
        <span class="prompt" aria-hidden="true">$</span>
        <span>${command}</span>
      </div>

      <footer class="footer">
        <span class="status-dot" aria-hidden="true"></span>
        <span>${statusLabel}</span>
      </footer>
    </div>
  </main>
</body>
</html>`;
}

export type OAuthSession = z.infer<typeof sessionSchema>;
type Discovery = z.infer<typeof discoverySchema>;

function account(environment: CobaltEnvironment): string {
  return `${environment.name}:${environment.clientId}:${environment.oauthResource.host}`;
}

export class TokenProvider {
  private accessToken: string | undefined;
  private expiresAt = 0;
  private refreshing: Promise<string> | undefined;

  public constructor(
    private readonly environment: CobaltEnvironment,
    private readonly store: CredentialStore,
  ) {}

  public usesEnvironmentToken(): boolean {
    return process.env.COBALT_TOKEN !== undefined;
  }

  public async preflight(scopes: readonly string[]): Promise<void> {
    if (scopes.length === 0 || this.usesEnvironmentToken()) return;
    const raw = await this.store.get(account(this.environment));
    if (!raw) return;
    const session = parseSession(raw);
    const granted = new Set(session.scope.split(/\s+/));
    const missing = scopes.filter((scope) => !granted.has(scope));
    if (missing.length)
      throw new CliError(
        `The saved OAuth session lacks required scope '${missing.join("', '")}'. Run 'cobalt auth login' to grant it.`,
        ExitCode.authorization,
      );
  }

  public async getAccessToken(signal?: AbortSignal): Promise<string> {
    const supplied = process.env.COBALT_TOKEN;
    if (supplied !== undefined) {
      if (!supplied.trim() || supplied.trim() !== supplied)
        throw new CliError("COBALT_TOKEN is invalid.", ExitCode.authentication);
      return supplied;
    }
    if (this.accessToken && this.expiresAt > Date.now() + 60_000)
      return this.accessToken;
    this.refreshing ??= this.refresh(signal).finally(() => {
      this.refreshing = undefined;
    });
    return await this.refreshing;
  }

  public async invalidate(): Promise<void> {
    this.accessToken = undefined;
    this.expiresAt = 0;
    if (!this.usesEnvironmentToken())
      await this.store.delete(account(this.environment));
  }

  public async refreshAfterUnauthorized(signal?: AbortSignal): Promise<string> {
    if (this.usesEnvironmentToken())
      throw new CliError(
        "The environment-supplied token was rejected.",
        ExitCode.authentication,
      );
    this.accessToken = undefined;
    this.expiresAt = 0;
    this.refreshing ??= this.refresh(signal).finally(() => {
      this.refreshing = undefined;
    });
    return await this.refreshing;
  }

  private async refresh(signal?: AbortSignal): Promise<string> {
    const raw = await this.store.get(account(this.environment));
    if (!raw)
      throw new CliError(
        "Authentication required. Run 'cobalt auth login' or set COBALT_TOKEN.",
        ExitCode.authentication,
      );
    const session = parseSession(raw);
    const discovery = await getDiscovery(this.environment, signal);
    const response = await identityFetch(
      discovery.token_endpoint,
      {
        method: "POST",
        redirect: "error",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          grant_type: "refresh_token",
          refresh_token: session.refreshToken,
          client_id: this.environment.clientId,
          resource: resource(this.environment),
        }),
      },
      signal,
    );
    if (!response.ok) {
      const oauthError: { error?: string | undefined } = await readBoundedJson(
        response,
        z.looseObject({ error: z.string().optional() }),
        64 * 1024,
      ).catch((error): { error?: string | undefined } => {
        if (isResponseReadFailure(error)) throw error;
        return {};
      });
      if (oauthError.error === "invalid_grant" || response.status === 401) {
        await this.store.delete(account(this.environment));
        throw new CliError(
          "The saved OAuth session expired or was revoked. Run 'cobalt auth login'.",
          ExitCode.authentication,
        );
      }
      if (response.status === 429)
        throw new CliError(
          "Identity rate limited the session refresh.",
          ExitCode.rateLimited,
        );
      if (response.status >= 500)
        throw new CliError(
          "Identity is temporarily unavailable; the saved session was retained.",
          ExitCode.unavailable,
        );
      throw new CliError(
        "Identity rejected the saved OAuth session.",
        ExitCode.authentication,
      );
    }
    const tokens = await readBoundedJson(response, tokenSchema);
    await validateTokens(
      tokens.access_token,
      tokens.id_token,
      discovery,
      this.environment,
      session.subject,
      undefined,
      signal,
    );
    validateGrantedScopes(tokens.scope ?? session.scope, session.scope);
    this.accessToken = tokens.access_token;
    this.expiresAt = Date.now() + tokens.expires_in * 1000;
    if (tokens.refresh_token)
      await this.store.set(
        account(this.environment),
        JSON.stringify({
          ...session,
          refreshToken: tokens.refresh_token,
          scope: tokens.scope ?? session.scope,
          savedAt: new Date().toISOString(),
        }),
      );
    return tokens.access_token;
  }
}

export async function login(
  environment: CobaltEnvironment,
  store: CredentialStore,
  readOnly: boolean,
  open: boolean,
  signal?: AbortSignal,
): Promise<void> {
  await validateProtectedResource(environment, signal);
  const discovery = await getDiscovery(environment, signal);
  const verifier = crypto.randomBytes(64).toString("base64url");
  const challenge = crypto
    .createHash("sha256")
    .update(verifier, "ascii")
    .digest("base64url");
  const state = crypto.randomBytes(32).toString("base64url");
  const nonce = crypto.randomBytes(32).toString("base64url");
  const server = http.createServer();
  const redirect = await listen(server);
  const scopes = readOnly
    ? "openid profile offline_access cobaltcode.external.read"
    : "openid profile offline_access cobaltcode.external.read cobaltcode.external.operate cobaltcode.external.create";
  const authorization = new URL(discovery.authorization_endpoint);
  for (const [key, value] of Object.entries({
    response_type: "code",
    client_id: environment.clientId,
    redirect_uri: redirect,
    scope: scopes,
    resource: resource(environment),
    code_challenge: challenge,
    code_challenge_method: "S256",
    state,
    nonce,
  }))
    authorization.searchParams.set(key, value);
  const loginEntry = new URL("/auth/login", environment.webFrontend);
  loginEntry.searchParams.set("returnUrl", authorization.toString());
  try {
    if (open) await openBrowser(loginEntry.toString());
    else process.stderr.write(`${loginEntry.toString()}\n`);
    const code = await callback(server, state, signal);
    const response = await identityFetch(
      discovery.token_endpoint,
      {
        method: "POST",
        redirect: "error",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          grant_type: "authorization_code",
          code,
          redirect_uri: redirect,
          client_id: environment.clientId,
          code_verifier: verifier,
          resource: resource(environment),
        }),
      },
      signal,
    );
    if (!response.ok)
      throw new CliError(
        "Identity rejected the OAuth code exchange.",
        ExitCode.authentication,
      );
    const tokens = await readBoundedJson(response, tokenSchema);
    if (!tokens.refresh_token || !tokens.id_token)
      throw new CliError(
        "Identity did not return a complete offline session.",
        ExitCode.authentication,
      );
    const subject = await validateTokens(
      tokens.access_token,
      tokens.id_token,
      discovery,
      environment,
      undefined,
      nonce,
      signal,
    );
    validateGrantedScopes(tokens.scope ?? scopes, scopes);
    await store.set(
      account(environment),
      JSON.stringify({
        refreshToken: tokens.refresh_token,
        subject,
        scope: tokens.scope ?? scopes,
        savedAt: new Date().toISOString(),
      }),
    );
  } finally {
    server.close();
  }
}

export async function logout(
  environment: CobaltEnvironment,
  store: CredentialStore,
  signal?: AbortSignal,
): Promise<boolean> {
  const key = account(environment);
  const raw = await store.get(key);
  let revoked = !raw;
  try {
    if (raw) {
      const session = parseSession(raw);
      const discovery = await getDiscovery(environment, signal);
      if (discovery.revocation_endpoint) {
        const response = await identityFetch(
          discovery.revocation_endpoint,
          {
            method: "POST",
            redirect: "error",
            headers: { "content-type": "application/x-www-form-urlencoded" },
            body: new URLSearchParams({
              token: session.refreshToken,
              token_type_hint: "refresh_token",
              client_id: environment.clientId,
            }),
          },
          signal,
        );
        revoked = response.ok;
      }
    }
  } catch (error) {
    if (signal?.aborted) throw error;
    revoked = false;
  }
  await store.delete(key);
  return revoked;
}

export async function authStatus(
  environment: CobaltEnvironment,
  store: CredentialStore,
): Promise<Record<string, unknown>> {
  const supplied = process.env.COBALT_TOKEN;
  if (
    supplied !== undefined &&
    (!supplied.trim() || supplied.trim() !== supplied)
  )
    throw new CliError("COBALT_TOKEN is invalid.", ExitCode.authentication);
  const raw =
    supplied === undefined ? await store.get(account(environment)) : null;
  const session = raw ? parseSession(raw) : null;
  return {
    authenticated: supplied !== undefined || session !== null,
    source: supplied !== undefined ? "environment" : session ? "oauth" : "none",
    environment: environment.name,
    subject: session?.subject ?? null,
    scopes: session?.scope.split(/\s+/) ?? null,
    savedAt: session?.savedAt ?? null,
    expiryState:
      supplied !== undefined ? "unknown" : session ? "refreshable" : "none",
  };
}

async function getDiscovery(
  environment: CobaltEnvironment,
  signal?: AbortSignal,
): Promise<Discovery> {
  const response = await identityFetch(
    new URL("/.well-known/openid-configuration", environment.identityIssuer),
    { redirect: "error" },
    signal,
  );
  if (!response.ok)
    throw new CliError("Identity discovery failed.", ExitCode.authentication);
  const value = await readBoundedJson(response, discoverySchema);
  const expected = environment.identityIssuer;
  if (
    new URL(value.issuer).toString().replace(/\/$/, "") !==
    expected.toString().replace(/\/$/, "")
  )
    throw new CliError(
      "Identity discovery metadata does not match the selected environment.",
      ExitCode.authentication,
    );
  for (const endpoint of [
    value.authorization_endpoint,
    value.token_endpoint,
    value.jwks_uri,
    value.revocation_endpoint,
  ].filter(Boolean) as string[]) {
    if (new URL(endpoint).origin !== expected.origin)
      throw new CliError(
        "Identity discovery metadata does not match the selected environment.",
        ExitCode.authentication,
      );
  }
  return value;
}

async function validateProtectedResource(
  environment: CobaltEnvironment,
  signal?: AbortSignal,
): Promise<void> {
  const response = await identityFetch(
    new URL("/.well-known/oauth-protected-resource", environment.oauthResource),
    { redirect: "error" },
    signal,
  );
  if (!response.ok)
    throw new CliError(
      "External API protected-resource discovery failed.",
      ExitCode.authentication,
    );
  const value = await readBoundedJson(
    response,
    z.object({
      resource: z.string().url(),
      authorization_servers: z.array(z.string().url()).min(1),
      scopes_supported: z.array(z.string()),
    }),
  );
  const requiredScopes = [
    "cobaltcode.external.read",
    "cobaltcode.external.operate",
    "cobaltcode.external.create",
  ];
  if (
    new URL(value.resource).toString().replace(/\/$/, "") !==
      resource(environment) ||
    !value.authorization_servers.some(
      (item) => new URL(item).origin === environment.identityIssuer.origin,
    ) ||
    !requiredScopes.every((scope) => value.scopes_supported.includes(scope))
  )
    throw new CliError(
      "Protected-resource metadata does not match the selected environment.",
      ExitCode.authentication,
    );
}

async function validateTokens(
  accessToken: string,
  idToken: string | undefined,
  discovery: Discovery,
  environment: CobaltEnvironment,
  expectedSubject?: string,
  nonce?: string,
  signal?: AbortSignal,
): Promise<string> {
  if (!idToken) {
    if (accessToken.split(".").length !== 3) {
      if (!expectedSubject)
        throw new CliError(
          "Identity returned an opaque access token without a subject-bearing ID token.",
          ExitCode.authentication,
        );
      return expectedSubject;
    }
    const claims = decodeAccessToken(accessToken);
    const audience = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
    validateLifetime(claims.exp, claims.nbf);
    if (
      claims.iss !== discovery.issuer ||
      !audience.includes(resource(environment)) ||
      !claims.sub ||
      (expectedSubject && claims.sub !== expectedSubject) ||
      (claims.client_id !== environment.clientId &&
        claims.azp !== environment.clientId)
    )
      throw new CliError(
        "Identity returned an invalid access token.",
        ExitCode.authentication,
      );
    return claims.sub;
  }
  const jwksResponse = await identityFetch(
    discovery.jwks_uri,
    { redirect: "error" },
    signal,
  );
  if (!jwksResponse.ok)
    throw new CliError(
      "Identity signing-key discovery failed.",
      ExitCode.authentication,
    );
  const jwks = await readBoundedJson(
    jwksResponse,
    z.object({ keys: z.array(z.record(z.string(), z.unknown())).min(1) }),
  );
  let result;
  try {
    result = await jwtVerify(
      idToken,
      createLocalJWKSet(jwks as JSONWebKeySet),
      {
        issuer: discovery.issuer,
        audience: environment.clientId,
        clockTolerance: 60,
      },
    );
  } catch (error) {
    throw new CliError(
      "Identity returned an invalid or untrusted ID token.",
      ExitCode.authentication,
      { cause: error },
    );
  }
  const idAudience = Array.isArray(result.payload.aud)
    ? result.payload.aud
    : [result.payload.aud];
  if (
    !result.payload.sub ||
    (expectedSubject && result.payload.sub !== expectedSubject) ||
    (nonce && result.payload.nonce !== nonce) ||
    (idAudience.length > 1 && result.payload.azp !== environment.clientId) ||
    (result.payload.azp && result.payload.azp !== environment.clientId)
  )
    throw new CliError(
      "Identity returned an invalid or untrusted ID token.",
      ExitCode.authentication,
    );
  if (accessToken.split(".").length === 3) {
    const claims = decodeAccessToken(accessToken);
    const audience = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
    validateLifetime(claims.exp, claims.nbf);
    if (
      claims.iss !== discovery.issuer ||
      !audience.includes(resource(environment)) ||
      claims.sub !== result.payload.sub ||
      (claims.client_id !== environment.clientId &&
        claims.azp !== environment.clientId)
    )
      throw new CliError(
        "Identity returned an invalid access token.",
        ExitCode.authentication,
      );
  }
  return result.payload.sub;
}

function validateLifetime(
  expiresAt: number | undefined,
  notBefore: number | undefined,
): void {
  const now = Math.floor(Date.now() / 1000);
  if (!expiresAt || expiresAt < now - 60 || (notBefore && notBefore > now + 60))
    throw new CliError(
      "Identity returned an expired or not-yet-valid access token.",
      ExitCode.authentication,
    );
}

function decodeAccessToken(accessToken: string) {
  try {
    return decodeJwt(accessToken);
  } catch (error) {
    throw new CliError(
      "Identity returned an invalid access token.",
      ExitCode.authentication,
      { cause: error },
    );
  }
}

function validateGrantedScopes(
  grantedValue: string,
  requestedValue: string,
): void {
  const granted = new Set(grantedValue.split(/\s+/));
  const missing = requestedValue
    .split(/\s+/)
    .filter((scope) => scope.startsWith("cobaltcode.external."))
    .filter((scope) => !granted.has(scope));
  if (missing.length)
    throw new CliError(
      `Identity did not grant required scope '${missing.join("', '")}'.`,
      ExitCode.authentication,
    );
}

function parseSession(raw: string): OAuthSession {
  try {
    return sessionSchema.parse(JSON.parse(raw));
  } catch (error) {
    throw new ConfigurationError("The saved OAuth session is invalid.", {
      cause: error,
    });
  }
}

async function readBoundedJson<T>(
  response: Response,
  schema: z.ZodType<T>,
  maximumBytes = 1024 * 1024,
): Promise<T> {
  const contentType = response.headers
    .get("content-type")
    ?.split(";", 1)[0]
    ?.trim()
    .toLowerCase();
  if (contentType !== "application/json" && !contentType?.endsWith("+json"))
    throw new CliError(
      "Identity returned a non-JSON response.",
      ExitCode.authentication,
    );
  const declaredLength = Number(response.headers.get("content-length"));
  if (Number.isFinite(declaredLength) && declaredLength > maximumBytes)
    throw new CliError(
      "Identity returned an oversized response.",
      ExitCode.authentication,
    );
  let bytes: Uint8Array;
  try {
    bytes = await readBoundedBytes(response, maximumBytes);
  } catch (error) {
    if (error instanceof ResponseReadError)
      throw new CliError(
        error.interrupted
          ? "Authentication was interrupted."
          : "Identity response transport failed.",
        error.interrupted ? ExitCode.interrupted : ExitCode.unavailable,
        { cause: error },
      );
    throw new CliError(
      "Identity returned an oversized response.",
      ExitCode.authentication,
      { cause: error },
    );
  }
  if (!bytes.length || bytes.length > maximumBytes)
    throw new CliError(
      "Identity returned an invalid response size.",
      ExitCode.authentication,
    );
  try {
    return schema.parse(
      JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)),
    );
  } catch (error) {
    if (error instanceof CliError) throw error;
    throw new CliError(
      "Identity returned an invalid JSON response.",
      ExitCode.authentication,
      { cause: error },
    );
  }
}

function resource(environment: CobaltEnvironment): string {
  return environment.oauthResource.toString().replace(/\/$/, "");
}

async function listen(server: http.Server): Promise<string> {
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const address = server.address();
  if (!address || typeof address === "string")
    throw new CliError(
      "Could not reserve an OAuth callback port.",
      ExitCode.authentication,
    );
  return `http://127.0.0.1:${address.port}/callback/`;
}

async function callback(
  server: http.Server,
  expectedState: string,
  signal?: AbortSignal,
): Promise<string> {
  return await new Promise<string>((resolve, reject) => {
    let settled = false;
    const cleanup = () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      server.off("request", onRequest);
    };
    const succeed = (code: string) => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(code);
    };
    const fail = (error: CliError) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(error);
    };
    const onAbort = () =>
      fail(new CliError("OAuth login was interrupted.", ExitCode.interrupted));
    const onRequest = (
      request: http.IncomingMessage,
      response: http.ServerResponse,
    ) => {
      const url = new URL(request.url ?? "/", "http://127.0.0.1");
      const state = url.searchParams.get("state") ?? "";
      const validState =
        state.length === expectedState.length &&
        crypto.timingSafeEqual(Buffer.from(state), Buffer.from(expectedState));
      const code = url.searchParams.get("code");
      const authorizationError = url.searchParams.get("error");
      const success = validState && !authorizationError && Boolean(code);
      response.writeHead(success ? 200 : 400, {
        "cache-control": "no-store",
        "content-security-policy":
          "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
        "content-type": "text/html; charset=utf-8",
        "referrer-policy": "no-referrer",
        "x-content-type-options": "nosniff",
      });
      response.end(oauthCallbackPage(success));
      if (success) {
        succeed(code!);
      } else if (!validState) {
        fail(
          new CliError(
            "OAuth callback state validation failed.",
            ExitCode.authentication,
          ),
        );
      } else if (authorizationError) {
        fail(
          new CliError(
            authorizationError === "access_denied"
              ? "OAuth login was denied."
              : "Identity rejected OAuth login.",
            ExitCode.authentication,
          ),
        );
      } else {
        fail(
          new CliError(
            "OAuth callback did not include an authorization code.",
            ExitCode.authentication,
          ),
        );
      }
    };
    const timer = setTimeout(
      () =>
        fail(new CliError("OAuth login timed out.", ExitCode.authentication)),
      300_000,
    );
    server.once("request", onRequest);
    signal?.addEventListener("abort", onAbort, { once: true });
    if (signal?.aborted) onAbort();
  });
}

async function identityFetch(
  input: string | URL | Request,
  init: RequestInit,
  signal?: AbortSignal,
): Promise<Response> {
  const requestSignal = signal
    ? AbortSignal.any([signal, AbortSignal.timeout(identityRequestTimeoutMs)])
    : AbortSignal.timeout(identityRequestTimeoutMs);
  try {
    const response = await fetch(input, { ...init, signal: requestSignal });
    trackResponseForegroundSignal(response, signal);
    return response;
  } catch (error) {
    if (signal?.aborted)
      throw new CliError(
        "Authentication was interrupted.",
        ExitCode.interrupted,
        { cause: error },
      );
    throw new CliError("Identity is unavailable.", ExitCode.unavailable, {
      cause: error,
    });
  }
}

function isResponseReadFailure(error: unknown): boolean {
  return error instanceof CliError && error.cause instanceof ResponseReadError;
}

export async function openBrowser(url: string): Promise<void> {
  if (process.platform === "darwin") await execFileAsync("open", [url]);
  else if (process.platform === "win32")
    await execFileAsync(
      "powershell.exe",
      [
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        "Start-Process -FilePath $env:COBALT_AUTH_URL",
      ],
      {
        env: { ...process.env, COBALT_AUTH_URL: url },
        windowsHide: true,
      },
    );
  else await execFileAsync("xdg-open", [url]);
}
