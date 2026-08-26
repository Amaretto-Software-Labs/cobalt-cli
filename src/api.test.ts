import { afterEach, describe, expect, it, vi } from "vitest";
import { CobaltApiClient, validId } from "./api.js";
import type { TokenProvider } from "./auth.js";
import { resolveEnvironment } from "./environment.js";
import { ApiError } from "./errors.js";

const tokenProvider = {
  getAccessToken: vi.fn(async () => "token"),
  usesEnvironmentToken: vi.fn(() => true),
  refreshAfterUnauthorized: vi.fn(),
  invalidate: vi.fn(),
} as unknown as TokenProvider;

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("CobaltApiClient", () => {
  it("retries a mutation with the same body and idempotency key", async () => {
    const requests: RequestInit[] = [];
    let call = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: URL, init: RequestInit) => {
        requests.push(init);
        call++;
        if (call === 1)
          return json(
            {
              type: "urn:test",
              title: "Unavailable",
              status: 503,
              detail: "retry",
              code: "unavailable",
              retryable: true,
              traceId: "trace",
              details: {},
            },
            503,
          );
        return json(
          {
            messageId: "11111111-1111-4111-8111-111111111111",
            taskId: "22222222-2222-4222-8222-222222222222",
            sequence: 1,
            status: "accepted",
            createdAt: "2026-08-25T12:00:00Z",
            lastEventSequence: 2,
          },
          202,
          { "cobalt-idempotency-outcome": "created" },
        );
      }),
    );
    const client = new CobaltApiClient(
      resolveEnvironment("prod"),
      tokenProvider,
    );
    const key = "33333333-3333-4333-8333-333333333333";
    const result = await client.sendMessage(
      "22222222-2222-4222-8222-222222222222",
      { message: "hello" },
      key,
    );
    expect(result.outcome).toBe("created");
    expect(requests).toHaveLength(2);
    expect(requests[0]?.body).toBe(requests[1]?.body);
    expect(requests.every((request) => request.redirect === "error")).toBe(
      true,
    );
    expect(new Headers(requests[0]?.headers).get("idempotency-key")).toBe(key);
    expect(new Headers(requests[1]?.headers).get("idempotency-key")).toBe(key);
  });

  it("does not automatically retry the long-poll endpoint", async () => {
    const fetch = vi.fn(async () =>
      json(
        {
          type: "urn:test",
          title: "Unavailable",
          status: 503,
          detail: "retry",
          code: "unavailable",
          retryable: true,
          traceId: "trace",
          details: {},
        },
        503,
      ),
    );
    vi.stubGlobal("fetch", fetch);
    const client = new CobaltApiClient(
      resolveEnvironment("prod"),
      tokenProvider,
    );
    await expect(
      client.waitForTasks({
        targets: [
          { taskId: "22222222-2222-4222-8222-222222222222", afterSequence: 0 },
        ],
        timeoutSeconds: 1,
      }),
    ).rejects.toBeInstanceOf(ApiError);
    expect(fetch).toHaveBeenCalledOnce();
  });

  it("cancels a retry delay without waiting for Retry-After", async () => {
    const fetch = vi.fn(async () =>
      json(
        {
          type: "urn:test",
          title: "Unavailable",
          status: 503,
          detail: "retry",
          code: "unavailable",
          retryable: true,
          traceId: "trace",
          details: {},
        },
        503,
        { "retry-after": "10" },
      ),
    );
    vi.stubGlobal("fetch", fetch);
    const foreground = new AbortController();
    const pending = new CobaltApiClient(
      resolveEnvironment("prod"),
      tokenProvider,
    ).listWorkspaces(100, undefined, foreground.signal);
    await vi.waitFor(() => expect(fetch).toHaveBeenCalledOnce());

    foreground.abort();

    await expect(pending).rejects.toMatchObject({ exitCode: 130 });
    expect(fetch).toHaveBeenCalledOnce();
  });

  it("propagates foreground cancellation without retrying", async () => {
    const fetch = vi.fn(
      async (_url: URL, init: RequestInit) =>
        await new Promise<Response>((_resolve, reject) => {
          if (init.signal?.aborted) {
            reject(new DOMException("cancelled", "AbortError"));
            return;
          }
          init.signal?.addEventListener("abort", () =>
            reject(new DOMException("cancelled", "AbortError")),
          );
        }),
    );
    vi.stubGlobal("fetch", fetch);
    const controller = new AbortController();
    const pending = new CobaltApiClient(
      resolveEnvironment("prod"),
      tokenProvider,
    ).listWorkspaces(100, undefined, controller.signal);
    controller.abort();

    await expect(pending).rejects.toMatchObject({ exitCode: 130 });
    expect(fetch).toHaveBeenCalledOnce();
    expect(tokenProvider.getAccessToken).toHaveBeenLastCalledWith(
      controller.signal,
    );
  });

  it("maps foreground cancellation after response headers to interrupted", async () => {
    const foreground = new AbortController();
    const fetch = vi.fn(async (_url: URL, init: RequestInit) =>
      streamingJsonResponse(init.signal!),
    );
    vi.stubGlobal("fetch", fetch);
    const pending = new CobaltApiClient(
      resolveEnvironment("prod"),
      tokenProvider,
    ).listWorkspaces(100, undefined, foreground.signal);
    await vi.waitFor(() => expect(fetch).toHaveBeenCalledOnce());

    foreground.abort();

    await expect(pending).rejects.toMatchObject({ exitCode: 130 });
  });

  it("maps a transport timeout after response headers to unavailable", async () => {
    const transport = new AbortController();
    vi.spyOn(AbortSignal, "timeout").mockReturnValue(transport.signal);
    const fetch = vi.fn(async (_url: URL, init: RequestInit) =>
      streamingJsonResponse(init.signal!),
    );
    vi.stubGlobal("fetch", fetch);
    const pending = new CobaltApiClient(
      resolveEnvironment("prod"),
      tokenProvider,
    ).listWorkspaces();
    await vi.waitFor(() => expect(fetch).toHaveBeenCalledOnce());

    transport.abort(new DOMException("timed out", "TimeoutError"));

    await expect(pending).rejects.toMatchObject({ exitCode: 8 });
  });

  it("rejects invalid response shapes through Zod", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        json({ items: [{ id: "not-a-uuid" }], hasMore: false }),
      ),
    );
    const client = new CobaltApiClient(
      resolveEnvironment("prod"),
      tokenProvider,
    );
    await expect(client.listWorkspaces()).rejects.toMatchObject({
      exitCode: 8,
    });
  });

  it("accepts canonical .NET GUIDs without RFC version bits", async () => {
    const legacyId = "434c20bf-acdd-4e7b-fe14-6e7d871065e7";
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        json({
          items: [
            {
              id: legacyId,
              label: "Existing account",
              agentKind: "codex",
              status: "unavailable",
              isDefault: false,
              defaultModel: null,
              models: [],
            },
          ],
          hasMore: false,
        }),
      ),
    );

    const page = await new CobaltApiClient(
      resolveEnvironment("prod"),
      tokenProvider,
    ).listAgents();

    expect(page.items[0]?.id).toBe(legacyId);
    expect(validId(legacyId.toUpperCase())).toBe(legacyId);
  });

  it("refreshes once after unauthorized and retries with the rotated token", async () => {
    const headers: string[] = [];
    const provider = {
      getAccessToken: vi.fn(async () => "old"),
      usesEnvironmentToken: vi.fn(() => false),
      refreshAfterUnauthorized: vi.fn(async () => "new"),
      invalidate: vi.fn(),
    } as unknown as TokenProvider;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: URL, init: RequestInit) => {
        headers.push(new Headers(init.headers).get("authorization")!);
        return headers.length === 1
          ? json(
              {
                type: "urn:test",
                title: "Unauthorized",
                status: 401,
                detail: "expired",
                code: "unauthorized",
                retryable: false,
                traceId: "trace",
                details: {},
              },
              401,
            )
          : json({ items: [], hasMore: false });
      }),
    );
    const controller = new AbortController();
    await new CobaltApiClient(
      resolveEnvironment("prod"),
      provider,
    ).listWorkspaces(100, undefined, controller.signal);
    expect(headers).toEqual(["Bearer old", "Bearer new"]);
    expect(provider.getAccessToken).toHaveBeenCalledWith(controller.signal);
    expect(provider.refreshAfterUnauthorized).toHaveBeenCalledWith(
      controller.signal,
    );
    expect(provider.invalidate).not.toHaveBeenCalled();
  });

  it("invalidates a saved session after persistent unauthorized", async () => {
    const provider = {
      getAccessToken: vi.fn(async () => "old"),
      usesEnvironmentToken: vi.fn(() => false),
      refreshAfterUnauthorized: vi.fn(async () => "new"),
      invalidate: vi.fn(async () => undefined),
    } as unknown as TokenProvider;
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        json(
          {
            type: "urn:test",
            title: "Unauthorized",
            status: 401,
            detail: "expired",
            code: "unauthorized",
            retryable: false,
            traceId: "trace",
            details: {},
          },
          401,
        ),
      ),
    );
    await expect(
      new CobaltApiClient(
        resolveEnvironment("prod"),
        provider,
      ).listWorkspaces(),
    ).rejects.toMatchObject({ exitCode: 3 });
    expect(provider.refreshAfterUnauthorized).toHaveBeenCalledOnce();
    expect(provider.invalidate).toHaveBeenCalledOnce();
  });

  it("trace output excludes tokens and query values", async () => {
    const writes: string[] = [];
    vi.spyOn(process.stderr, "write").mockImplementation((value) => {
      writes.push(String(value));
      return true;
    });
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => json({ items: [], hasMore: false })),
    );
    await new CobaltApiClient(
      resolveEnvironment("prod"),
      tokenProvider,
      true,
    ).listWorkspaces(100, "secret-cursor");
    const trace = writes.join("");
    expect(trace).toContain("GET https://api.cobaltcode.ai/v1/workspaces");
    expect(trace).not.toContain("secret-cursor");
    expect(trace).not.toContain("Bearer");
  });
});

function json(
  value: unknown,
  status = 200,
  headers: Record<string, string> = {},
): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json", ...headers },
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
