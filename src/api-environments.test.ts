import { afterEach, describe, expect, it, vi } from "vitest";
import { CobaltApiClient } from "./api.js";
import type { TokenProvider } from "./auth.js";
import { resolveEnvironment } from "./environment.js";

const workspace = "11111111-1111-4111-8111-111111111111";
const task = "22222222-2222-4222-8222-222222222222";
const key = "33333333-3333-4333-8333-333333333333";
const environment = "44444444-4444-4444-8444-444444444444";
const attachmentId = "55555555-5555-4555-8555-555555555555";
const sidecar = {
  id: null,
  label: "db",
  name: "Database",
  templateId: "certified-db",
  templateRevision: 1,
  imageDigest: "sha256:" + "a".repeat(64),
  architecture: "x86_64" as const,
  cpuCores: 2,
  memoryMiB: 4096,
  rootDiskGiB: 10,
  command: [],
  initializeCommand: null,
  readiness: { kind: "tcp" as const, port: 5432 },
};
const definition = {
  name: "Database",
  description: null,
  sidecars: [sidecar],
  authorizeService: false,
};
const view = {
  id: environment,
  workspaceId: workspace,
  ...definition,
  sidecars: [],
  generation: 1,
  desiredPower: "stopped",
  status: "stopped",
  failureCode: null,
  serviceAuthorized: false,
  networkId: null,
  idleGraceMinutes: 10,
  allowedActions: ["delete"],
};
const operation = {
  id: key,
  environmentId: environment,
  action: "start",
  generation: 2,
  status: "pending",
  failureCode: null,
  createdAt: "2026-10-12T10:00:00Z",
  updatedAt: "2026-10-12T10:00:00Z",
};
const attachment = {
  id: attachmentId,
  taskId: task,
  environmentId: environment,
  environmentName: "Db",
  generation: 1,
  desiredMembership: "attached",
  membershipStatus: "recorded",
  connectivity: "inactive",
  connectivityReason: "vm_suspended",
  dependencyStatus: "ready",
  isDefaultDns: false,
  endpoints: {},
  connectionBindings: {},
};
const attachments = {
  generation: 1,
  attachments: [attachment],
  defaultDnsAttachmentId: null,
};
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
function setup(response: unknown) {
  const fetch = vi.fn(async (url: URL, init: RequestInit) => {
    void url;
    void init;
    return new Response(JSON.stringify(response), {
      status: 202,
      headers: {
        "content-type": "application/json",
        "cobalt-idempotency-outcome": "created",
      },
    });
  });
  vi.stubGlobal("fetch", fetch);
  const client = new CobaltApiClient(resolveEnvironment("prod"), {
    getAccessToken: async () => "token",
  } as unknown as TokenProvider);
  return { fetch, client };
}
describe("environment API transport parity", () => {
  it("round trips a network-only environment with no sidecars", async () => {
    const { client, fetch } = setup(view);
    const result = await client.createEnvironment(
      workspace,
      { ...definition, sidecars: [] },
      key,
    );
    expect(result.value.sidecars).toEqual([]);
    expect(JSON.parse(fetch.mock.calls[0]![1].body as string).sidecars).toEqual(
      [],
    );
  });
  it("reads bounded diagnostics without sending a mutation identity", async () => {
    const response = {
      environmentId: environment,
      sidecarId: attachmentId,
      status: "blocked",
      failureCode: "probe_failed",
      diagnostics: {
        logTail: "[REDACTED] connection refused",
        logTruncated: false,
        probeKind: "command",
        probeState: "failed",
        probeFailureCode: "managed_service_probe_failed",
        probeObservedAt: null,
        probeDurationMilliseconds: 12,
      },
    };
    const { client, fetch } = setup(response);
    expect(await client.sidecarDiagnostics(environment, attachmentId)).toEqual(
      response,
    );
    const [url, request] = fetch.mock.calls[0]!;
    expect(String(url)).toBe(
      `https://api.cobaltcode.ai/v1/environments/${environment}/sidecars/${attachmentId}/diagnostics`,
    );
    expect(request.method).toBe("GET");
    expect(new Headers(request.headers).has("Idempotency-Key")).toBe(false);
  });
  it("rejects oversized diagnostic evidence before rendering console output", async () => {
    const { client } = setup({
      environmentId: environment,
      sidecarId: attachmentId,
      status: "ready",
      failureCode: null,
      diagnostics: {
        logTail: "x".repeat(8193),
        logTruncated: true,
        probeKind: "tcp",
        probeState: "succeeded",
        probeFailureCode: null,
        probeObservedAt: null,
        probeDurationMilliseconds: 1,
      },
    });
    await expect(
      client.sidecarDiagnostics(environment, attachmentId),
    ).rejects.toThrow();
  });
  it("validates Cobalt suspended membership and clears DNS with explicit null", async () => {
    const { fetch, client } = setup(attachments);
    const result = await client.setTaskEnvironmentDnsDefault(
      task,
      null,
      3,
      key,
    );
    expect(result.value.attachments[0]?.membershipStatus).toBe("recorded");
    const [url, request] = fetch.mock.calls[0]!;
    expect(String(url)).toBe(
      `https://api.cobaltcode.ai/v1/tasks/${task}/environment-dns-default`,
    );
    expect(request.method).toBe("PUT");
    expect(JSON.parse(String(request.body))).toEqual({
      attachmentId: null,
      expectedGeneration: 3,
    });
    expect(new Headers(request.headers).get("idempotency-key")).toBe(key);
  });
  it("deletes one attachment with concurrency in the query and no request body", async () => {
    const { fetch, client } = setup({
      ...attachment,
      desiredMembership: "detached",
      membershipStatus: "retired",
    });
    await client.detachTaskEnvironment(task, attachmentId, 8, key);
    const [url, request] = fetch.mock.calls[0]!;
    expect(String(url)).toBe(
      `https://api.cobaltcode.ai/v1/tasks/${task}/environment-attachments/${attachmentId}?expectedGeneration=8`,
    );
    expect(request.method).toBe("DELETE");
    expect(request.body).toBeUndefined();
  });
  it("creates and updates complete definitions using documented bodies", async () => {
    const { fetch, client } = setup(view);
    await client.createEnvironment(workspace, definition, key);
    await client.updateEnvironment(environment, definition, 2, key);
    expect(String(fetch.mock.calls[0]![0])).toContain(
      `workspaces/${workspace}/environments`,
    );
    expect(JSON.parse(String(fetch.mock.calls[0]![1].body))).toEqual(
      definition,
    );
    expect(fetch.mock.calls[1]![1].method).toBe("PUT");
    expect(JSON.parse(String(fetch.mock.calls[1]![1].body))).toEqual({
      definition,
      expectedGeneration: 2,
    });
  });
  it("uses operation replies and environment generation for sidecar actions", async () => {
    const { fetch, client } = setup(operation);
    await client.environmentAction(environment, "revoke_service", 1, key);
    await client.sidecarAction(environment, attachmentId, "restart", 1, key);
    expect(String(fetch.mock.calls[0]![0])).toContain(
      `/environments/${environment}/actions/revoke_service`,
    );
    expect(String(fetch.mock.calls[1]![0])).toContain(
      `/environments/${environment}/sidecars/${attachmentId}/actions/restart`,
    );
  });
  it("rejects a malformed provider response instead of accepting active connectivity", async () => {
    const { client } = setup({
      ...attachments,
      attachments: [{ ...attachment, generation: 0 }],
    });
    await expect(client.listTaskEnvironmentAttachments(task)).rejects.toThrow();
  });
});
