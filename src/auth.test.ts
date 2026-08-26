import http from "node:http";
import { exportJWK, generateKeyPair, SignJWT } from "jose";
import { afterEach, describe, expect, it, vi } from "vitest";
import { login, logout, TokenProvider } from "./auth.js";
import { MemoryCredentialStore } from "./credential-store.js";
import { resolveEnvironment } from "./environment.js";

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("OAuth login", () => {
  it("uses a bound S256 loopback flow and stores only the refresh session", async () => {
    const environment = resolveEnvironment("prod");
    const store = new MemoryCredentialStore();
    const { privateKey, publicKey } = await generateKeyPair("ES256");
    const jwk = {
      ...(await exportJWK(publicKey)),
      kid: "test",
      alg: "ES256",
      use: "sig",
    };
    let loginUrl: URL | undefined;
    let authorizationUrl: URL | undefined;
    const requests: RequestInit[] = [];
    vi.spyOn(process.stderr, "write").mockImplementation((value) => {
      const text = String(value).trim();
      if (text.startsWith("https://")) {
        loginUrl = new URL(text);
        authorizationUrl = authorizationFromLoginEntry(text);
      }
      return true;
    });
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
        requests.push(init ?? {});
        const url = new URL(
          typeof input === "string" || input instanceof URL ? input : input.url,
        );
        if (url.pathname === "/.well-known/oauth-protected-resource")
          return json({
            resource: "https://api.cobaltcode.ai",
            authorization_servers: ["https://identity.cobaltcode.ai"],
            scopes_supported: [
              "cobaltcode.external.read",
              "cobaltcode.external.operate",
              "cobaltcode.external.create",
            ],
          });
        if (url.pathname === "/.well-known/openid-configuration")
          return json({
            issuer: "https://identity.cobaltcode.ai",
            authorization_endpoint:
              "https://identity.cobaltcode.ai/connect/authorize",
            token_endpoint: "https://identity.cobaltcode.ai/connect/token",
            jwks_uri: "https://identity.cobaltcode.ai/.well-known/jwks",
            revocation_endpoint:
              "https://identity.cobaltcode.ai/connect/revoke",
          });
        if (url.pathname === "/.well-known/jwks") return json({ keys: [jwk] });
        if (url.pathname === "/connect/token") {
          if (!authorizationUrl)
            throw new Error("authorization URL was not emitted");
          const idToken = await new SignJWT({
            nonce: authorizationUrl.searchParams.get("nonce"),
          })
            .setProtectedHeader({ alg: "ES256", kid: "test" })
            .setIssuer("https://identity.cobaltcode.ai")
            .setAudience(environment.clientId)
            .setSubject("user-123")
            .setIssuedAt()
            .setExpirationTime("5m")
            .sign(privateKey);
          return json({
            access_token: "opaque-access-token",
            refresh_token: "refresh-token",
            expires_in: 300,
            scope:
              "openid profile offline_access cobaltcode.external.read cobaltcode.external.operate cobaltcode.external.create",
            id_token: idToken,
          });
        }
        throw new Error(`Unexpected fetch ${url}`);
      }),
    );

    const controller = new AbortController();
    const pending = login(environment, store, false, false, controller.signal);
    await vi.waitFor(() => expect(authorizationUrl).toBeDefined());
    expect(loginUrl!.origin).toBe(environment.webFrontend.origin);
    expect(loginUrl!.pathname).toBe("/auth/login");
    expect(authorizationUrl!.searchParams.get("code_challenge_method")).toBe(
      "S256",
    );
    expect(authorizationUrl!.searchParams.get("code_challenge")).toMatch(
      /^[A-Za-z0-9_-]{43}$/,
    );
    expect(authorizationUrl!.searchParams.get("resource")).toBe(
      "https://api.cobaltcode.ai",
    );
    expect(authorizationUrl!.searchParams.get("nonce")).toBeTruthy();
    const redirect = new URL(
      authorizationUrl!.searchParams.get("redirect_uri")!,
    );
    expect(redirect.hostname).toBe("127.0.0.1");
    redirect.searchParams.set("code", "authorization-code");
    redirect.searchParams.set(
      "state",
      authorizationUrl!.searchParams.get("state")!,
    );
    const callbackResponse = await get(redirect);
    expect(callbackResponse.statusCode).toBe(200);
    expect(callbackResponse.headers["content-type"]).toBe(
      "text/html; charset=utf-8",
    );
    expect(callbackResponse.headers["cache-control"]).toBe("no-store");
    expect(callbackResponse.headers["content-security-policy"]).toContain(
      "default-src 'none'",
    );
    expect(callbackResponse.body).toContain(
      "Authorization complete · Cobalt CLI",
    );
    expect(callbackResponse.body).toContain("You're connected");
    expect(callbackResponse.body).toContain("cobalt auth status");
    expect(callbackResponse.body).toContain('aria-label="Cobalt"');
    await pending;

    const saved = await store.get("prod:cobalt-cli-prod:api.cobaltcode.ai");
    expect(JSON.parse(saved!)).toMatchObject({
      refreshToken: "refresh-token",
      subject: "user-123",
    });
    expect(saved).not.toContain("opaque-access-token");
    expect(requests).toHaveLength(4);
    expect(requests.every((request) => request.redirect === "error")).toBe(
      true,
    );
    expect(
      requests.every(
        (request) =>
          request.signal instanceof AbortSignal &&
          request.signal !== controller.signal,
      ),
    ).toBe(true);
  });

  it("cancels the loopback callback wait with the foreground signal", async () => {
    let authorizationUrl: URL | undefined;
    vi.spyOn(process.stderr, "write").mockImplementation((value) => {
      const text = String(value).trim();
      if (text.startsWith("https://"))
        authorizationUrl = authorizationFromLoginEntry(text);
      return true;
    });
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL | Request) => {
        const url = new URL(
          typeof input === "string" || input instanceof URL ? input : input.url,
        );
        if (url.pathname === "/.well-known/oauth-protected-resource")
          return json({
            resource: "https://api.cobaltcode.ai",
            authorization_servers: ["https://identity.cobaltcode.ai"],
            scopes_supported: [
              "cobaltcode.external.read",
              "cobaltcode.external.operate",
              "cobaltcode.external.create",
            ],
          });
        return json({
          issuer: "https://identity.cobaltcode.ai",
          authorization_endpoint:
            "https://identity.cobaltcode.ai/connect/authorize",
          token_endpoint: "https://identity.cobaltcode.ai/connect/token",
          jwks_uri: "https://identity.cobaltcode.ai/.well-known/jwks",
        });
      }),
    );
    const controller = new AbortController();
    const pending = login(
      resolveEnvironment("prod"),
      new MemoryCredentialStore(),
      false,
      false,
      controller.signal,
    );
    await vi.waitFor(() => expect(authorizationUrl).toBeDefined());

    controller.abort();

    await expect(pending).rejects.toMatchObject({ exitCode: 130 });
  });

  it("maps identity network failures to unavailable", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new TypeError("network unavailable");
      }),
    );

    await expect(
      login(
        resolveEnvironment("prod"),
        new MemoryCredentialStore(),
        false,
        false,
      ),
    ).rejects.toMatchObject({ exitCode: 8 });
  });

  it("maps foreground cancellation during an Identity body read to interrupted", async () => {
    const foreground = new AbortController();
    const fetch = vi.fn(
      async (_input: string | URL | Request, init?: RequestInit) =>
        streamingJsonResponse(init?.signal as AbortSignal),
    );
    vi.stubGlobal("fetch", fetch);
    const pending = login(
      resolveEnvironment("prod"),
      new MemoryCredentialStore(),
      false,
      false,
      foreground.signal,
    );
    await vi.waitFor(() => expect(fetch).toHaveBeenCalledOnce());

    foreground.abort();

    await expect(pending).rejects.toMatchObject({ exitCode: 130 });
  });

  it("maps an Identity transport timeout during a body read to unavailable", async () => {
    const transport = new AbortController();
    vi.spyOn(AbortSignal, "timeout").mockReturnValue(transport.signal);
    const fetch = vi.fn(
      async (_input: string | URL | Request, init?: RequestInit) =>
        streamingJsonResponse(init?.signal as AbortSignal),
    );
    vi.stubGlobal("fetch", fetch);
    const pending = login(
      resolveEnvironment("prod"),
      new MemoryCredentialStore(),
      false,
      false,
    );
    await vi.waitFor(() => expect(fetch).toHaveBeenCalledOnce());

    transport.abort(new DOMException("timed out", "TimeoutError"));

    await expect(pending).rejects.toMatchObject({ exitCode: 8 });
  });

  it("refuses redirects while revoking a refresh token", async () => {
    const environment = resolveEnvironment("prod");
    const store = await savedSession(environment);
    const requests: RequestInit[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
        requests.push(init ?? {});
        const url = new URL(
          typeof input === "string" || input instanceof URL ? input : input.url,
        );
        return url.pathname === "/.well-known/openid-configuration"
          ? json({
              issuer: "https://identity.cobaltcode.ai",
              authorization_endpoint:
                "https://identity.cobaltcode.ai/connect/authorize",
              token_endpoint: "https://identity.cobaltcode.ai/connect/token",
              jwks_uri: "https://identity.cobaltcode.ai/.well-known/jwks",
              revocation_endpoint:
                "https://identity.cobaltcode.ai/connect/revoke",
            })
          : json({});
      }),
    );

    await expect(logout(environment, store)).resolves.toBe(true);
    expect(requests).toHaveLength(2);
    expect(requests.every((request) => request.redirect === "error")).toBe(
      true,
    );
  });

  it("rejects protected-resource metadata bound to another environment", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        json({
          resource: "https://api-dev.cobaltcode.ai",
          authorization_servers: ["https://identity.cobaltcode.ai"],
          scopes_supported: [
            "cobaltcode.external.read",
            "cobaltcode.external.operate",
            "cobaltcode.external.create",
          ],
        }),
      ),
    );
    await expect(
      login(
        resolveEnvironment("prod"),
        new MemoryCredentialStore(),
        false,
        false,
      ),
    ).rejects.toMatchObject({ exitCode: 3 });
  });

  it("rejects a callback whose state does not match", async () => {
    let authorizationUrl: URL | undefined;
    vi.spyOn(process.stderr, "write").mockImplementation((value) => {
      const text = String(value).trim();
      if (text.startsWith("https://"))
        authorizationUrl = authorizationFromLoginEntry(text);
      return true;
    });
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL | Request) => {
        const url = new URL(
          typeof input === "string" || input instanceof URL ? input : input.url,
        );
        if (url.pathname === "/.well-known/oauth-protected-resource")
          return json({
            resource: "https://api.cobaltcode.ai",
            authorization_servers: ["https://identity.cobaltcode.ai"],
            scopes_supported: [
              "cobaltcode.external.read",
              "cobaltcode.external.operate",
              "cobaltcode.external.create",
            ],
          });
        return json({
          issuer: "https://identity.cobaltcode.ai",
          authorization_endpoint:
            "https://identity.cobaltcode.ai/connect/authorize",
          token_endpoint: "https://identity.cobaltcode.ai/connect/token",
          jwks_uri: "https://identity.cobaltcode.ai/.well-known/jwks",
        });
      }),
    );
    const pending = login(
      resolveEnvironment("prod"),
      new MemoryCredentialStore(),
      false,
      false,
    );
    const rejected = expect(pending).rejects.toMatchObject({ exitCode: 3 });
    await vi.waitFor(() => expect(authorizationUrl).toBeDefined());
    const redirect = new URL(
      authorizationUrl!.searchParams.get("redirect_uri")!,
    );
    redirect.searchParams.set("code", "authorization-code");
    redirect.searchParams.set("state", "wrong-state");
    await get(redirect);
    await rejected;
  });

  it.each([
    ["access_denied", "OAuth login was denied."],
    ["server_error", "Identity rejected OAuth login."],
    [undefined, "OAuth callback did not include an authorization code."],
  ])(
    "reports an OAuth callback error distinctly from state validation: %s",
    async (oauthError, expectedMessage) => {
      let authorizationUrl: URL | undefined;
      vi.spyOn(process.stderr, "write").mockImplementation((value) => {
        const text = String(value).trim();
        if (text.startsWith("https://"))
          authorizationUrl = authorizationFromLoginEntry(text);
        return true;
      });
      vi.stubGlobal(
        "fetch",
        vi.fn(async (input: string | URL | Request) => {
          const url = new URL(
            typeof input === "string" || input instanceof URL
              ? input
              : input.url,
          );
          if (url.pathname === "/.well-known/oauth-protected-resource")
            return json({
              resource: "https://api.cobaltcode.ai",
              authorization_servers: ["https://identity.cobaltcode.ai"],
              scopes_supported: [
                "cobaltcode.external.read",
                "cobaltcode.external.operate",
                "cobaltcode.external.create",
              ],
            });
          return json({
            issuer: "https://identity.cobaltcode.ai",
            authorization_endpoint:
              "https://identity.cobaltcode.ai/connect/authorize",
            token_endpoint: "https://identity.cobaltcode.ai/connect/token",
            jwks_uri: "https://identity.cobaltcode.ai/.well-known/jwks",
          });
        }),
      );

      const pending = login(
        resolveEnvironment("prod"),
        new MemoryCredentialStore(),
        false,
        false,
      );
      const rejected = expect(pending).rejects.toMatchObject({
        exitCode: 3,
        message: expectedMessage,
      });
      await vi.waitFor(() => expect(authorizationUrl).toBeDefined());
      const redirect = new URL(
        authorizationUrl!.searchParams.get("redirect_uri")!,
      );
      redirect.searchParams.set(
        "state",
        authorizationUrl!.searchParams.get("state")!,
      );
      if (oauthError) redirect.searchParams.set("error", oauthError);
      const callbackResponse = await get(redirect);
      expect(callbackResponse.statusCode).toBe(400);
      expect(callbackResponse.body).toContain(
        "Authorization failed · Cobalt CLI",
      );
      expect(callbackResponse.body).toContain("Sign-in wasn't completed");
      expect(callbackResponse.body).toContain("cobalt auth login");
      await rejected;
    },
  );

  it.each(["nonce", "signature"] as const)(
    "rejects an ID token with an invalid %s",
    async (failure) => {
      await expect(runInvalidIdTokenLogin(failure)).rejects.toMatchObject({
        exitCode: 3,
      });
    },
  );
});

describe("OAuth refresh token binding", () => {
  it("retains the saved session when Identity is temporarily unavailable", async () => {
    const environment = resolveEnvironment("prod");
    const store = await savedSession(environment);
    mockRefreshFailure(503, { error: "temporarily_unavailable" });

    await expect(
      new TokenProvider(environment, store).getAccessToken(),
    ).rejects.toMatchObject({ exitCode: 8 });
    await expect(store.get(accountKey(environment))).resolves.toBeTruthy();
  });

  it("deletes the saved session when the refresh grant is invalid", async () => {
    const environment = resolveEnvironment("prod");
    const store = await savedSession(environment);
    mockRefreshFailure(400, { error: "invalid_grant" });

    await expect(
      new TokenProvider(environment, store).getAccessToken(),
    ).rejects.toMatchObject({ exitCode: 3 });
    await expect(store.get(accountKey(environment))).resolves.toBeNull();
  });

  it.each([
    ["issuer", { iss: "https://identity-dev.cobaltcode.ai" }],
    ["resource", { aud: "https://api-dev.cobaltcode.ai" }],
    ["client", { client_id: "another-client" }],
    ["subject", { sub: "another-user" }],
    ["expiry", { exp: 1 }],
  ])(
    "rejects an access token with the wrong %s binding",
    async (_name, override) => {
      const environment = resolveEnvironment("prod");
      const store = await savedSession(environment);
      const token = jwt({
        iss: "https://identity.cobaltcode.ai",
        aud: "https://api.cobaltcode.ai",
        sub: "user-123",
        client_id: environment.clientId,
        exp: Math.floor(Date.now() / 1000) + 300,
        ...override,
      });
      mockRefresh(
        token,
        "cobaltcode.external.read cobaltcode.external.operate",
      );
      await expect(
        new TokenProvider(environment, store).getAccessToken(),
      ).rejects.toMatchObject({ exitCode: 3 });
    },
  );

  it("rejects silently narrowed External API scopes", async () => {
    const environment = resolveEnvironment("prod");
    const store = await savedSession(environment);
    const token = jwt({
      iss: "https://identity.cobaltcode.ai",
      aud: "https://api.cobaltcode.ai",
      sub: "user-123",
      client_id: environment.clientId,
      exp: Math.floor(Date.now() / 1000) + 300,
    });
    mockRefresh(token, "cobaltcode.external.read");
    await expect(
      new TokenProvider(environment, store).getAccessToken(),
    ).rejects.toMatchObject({ exitCode: 3 });
  });

  it("maps a malformed JWT access token to an authentication failure", async () => {
    const environment = resolveEnvironment("prod");
    const store = await savedSession(environment);
    mockRefresh(
      "not-json.not-json.signature",
      "cobaltcode.external.read cobaltcode.external.operate",
    );
    await expect(
      new TokenProvider(environment, store).getAccessToken(),
    ).rejects.toMatchObject({ exitCode: 3 });
  });
});

function json(value: unknown): Response {
  return new Response(JSON.stringify(value), {
    headers: { "content-type": "application/json" },
  });
}

function streamingJsonResponse(signal: AbortSignal): Response {
  return new Response(
    new ReadableStream({
      start(controller) {
        const fail = () => controller.error(signal.reason);
        signal.addEventListener("abort", fail, { once: true });
        if (signal.aborted) fail();
      },
    }),
    { headers: { "content-type": "application/json" } },
  );
}

async function savedSession(
  environment: ReturnType<typeof resolveEnvironment>,
): Promise<MemoryCredentialStore> {
  const store = new MemoryCredentialStore();
  await store.set(
    accountKey(environment),
    JSON.stringify({
      refreshToken: "refresh",
      subject: "user-123",
      scope:
        "openid offline_access cobaltcode.external.read cobaltcode.external.operate",
      savedAt: new Date().toISOString(),
    }),
  );
  return store;
}

function accountKey(
  environment: ReturnType<typeof resolveEnvironment>,
): string {
  return `${environment.name}:${environment.clientId}:${environment.oauthResource.host}`;
}

function mockRefreshFailure(
  status: number,
  body: Record<string, unknown>,
): void {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string | URL | Request) => {
      const url = new URL(
        typeof input === "string" || input instanceof URL ? input : input.url,
      );
      if (url.pathname === "/.well-known/openid-configuration")
        return json({
          issuer: "https://identity.cobaltcode.ai",
          authorization_endpoint:
            "https://identity.cobaltcode.ai/connect/authorize",
          token_endpoint: "https://identity.cobaltcode.ai/connect/token",
          jwks_uri: "https://identity.cobaltcode.ai/.well-known/jwks",
        });
      return new Response(JSON.stringify(body), {
        status,
        headers: { "content-type": "application/json" },
      });
    }),
  );
}

function mockRefresh(accessToken: string, scope: string): void {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string | URL | Request) => {
      const url = new URL(
        typeof input === "string" || input instanceof URL ? input : input.url,
      );
      if (url.pathname === "/.well-known/openid-configuration")
        return json({
          issuer: "https://identity.cobaltcode.ai",
          authorization_endpoint:
            "https://identity.cobaltcode.ai/connect/authorize",
          token_endpoint: "https://identity.cobaltcode.ai/connect/token",
          jwks_uri: "https://identity.cobaltcode.ai/.well-known/jwks",
        });
      return json({ access_token: accessToken, expires_in: 300, scope });
    }),
  );
}

function jwt(payload: Record<string, unknown>): string {
  return `${Buffer.from(JSON.stringify({ alg: "none" })).toString("base64url")}.${Buffer.from(JSON.stringify(payload)).toString("base64url")}.signature`;
}

async function runInvalidIdTokenLogin(
  failure: "nonce" | "signature",
): Promise<void> {
  const environment = resolveEnvironment("prod");
  const trusted = await generateKeyPair("ES256");
  const untrusted = await generateKeyPair("ES256");
  const jwk = {
    ...(await exportJWK(trusted.publicKey)),
    kid: "trusted",
    alg: "ES256",
    use: "sig",
  };
  let authorizationUrl: URL | undefined;
  vi.spyOn(process.stderr, "write").mockImplementation((value) => {
    const text = String(value).trim();
    if (text.startsWith("https://"))
      authorizationUrl = authorizationFromLoginEntry(text);
    return true;
  });
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string | URL | Request) => {
      const url = new URL(
        typeof input === "string" || input instanceof URL ? input : input.url,
      );
      if (url.pathname === "/.well-known/oauth-protected-resource")
        return json({
          resource: "https://api.cobaltcode.ai",
          authorization_servers: ["https://identity.cobaltcode.ai"],
          scopes_supported: [
            "cobaltcode.external.read",
            "cobaltcode.external.operate",
            "cobaltcode.external.create",
          ],
        });
      if (url.pathname === "/.well-known/openid-configuration")
        return json({
          issuer: "https://identity.cobaltcode.ai",
          authorization_endpoint:
            "https://identity.cobaltcode.ai/connect/authorize",
          token_endpoint: "https://identity.cobaltcode.ai/connect/token",
          jwks_uri: "https://identity.cobaltcode.ai/.well-known/jwks",
        });
      if (url.pathname === "/.well-known/jwks") return json({ keys: [jwk] });
      const idToken = await new SignJWT({
        nonce:
          failure === "nonce"
            ? "wrong"
            : authorizationUrl!.searchParams.get("nonce"),
      })
        .setProtectedHeader({ alg: "ES256", kid: "trusted" })
        .setIssuer("https://identity.cobaltcode.ai")
        .setAudience(environment.clientId)
        .setSubject("user-123")
        .setIssuedAt()
        .setExpirationTime("5m")
        .sign(
          failure === "signature" ? untrusted.privateKey : trusted.privateKey,
        );
      return json({
        access_token: "opaque",
        refresh_token: "refresh",
        expires_in: 300,
        scope:
          "cobaltcode.external.read cobaltcode.external.operate cobaltcode.external.create",
        id_token: idToken,
      });
    }),
  );
  const pending = login(environment, new MemoryCredentialStore(), false, false);
  await vi.waitFor(() => expect(authorizationUrl).toBeDefined());
  const redirect = new URL(authorizationUrl!.searchParams.get("redirect_uri")!);
  redirect.searchParams.set("code", "code");
  redirect.searchParams.set(
    "state",
    authorizationUrl!.searchParams.get("state")!,
  );
  await get(redirect);
  await pending;
}
async function get(url: URL): Promise<{
  statusCode: number | undefined;
  headers: http.IncomingHttpHeaders;
  body: string;
}> {
  return await new Promise((resolve, reject) => {
    http
      .get(url, (response) => {
        const chunks: Buffer[] = [];
        response.on("data", (chunk: Buffer) => chunks.push(chunk));
        response.on("end", () =>
          resolve({
            statusCode: response.statusCode,
            headers: response.headers,
            body: Buffer.concat(chunks).toString("utf8"),
          }),
        );
      })
      .on("error", reject);
  });
}

function authorizationFromLoginEntry(value: string): URL {
  const returnUrl = new URL(value).searchParams.get("returnUrl");
  if (!returnUrl) throw new Error("login entry URL did not include returnUrl");
  return new URL(returnUrl);
}
