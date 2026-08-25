import { afterEach, describe, expect, it, vi } from "vitest";
import type { ConfigStore } from "./config.js";
import { MemoryCredentialStore } from "./credential-store.js";
import { CliError } from "./errors.js";
import {
  Runtime,
  allPages,
  resolveRepositoryItem,
  resolveWorkspaceItem,
} from "./runtime.js";
import type { CobaltApiClient } from "./api.js";

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe("runtime workspace context", () => {
  it.each(["cli", "environment"] as const)(
    "uses %s override B for the effective label when saved workspace A differs",
    async (source) => {
      const workspaceA = workspace(
        "11111111-1111-4111-8111-111111111111",
        "Saved A",
      );
      const workspaceB = workspace(
        "22222222-2222-4222-8222-222222222222",
        "Override B",
      );
      const configStore = {
        load: vi.fn(async () => ({
          schemaVersion: 1 as const,
          currentEnvironment: "prod" as const,
          environments: {
            prod: {
              workspaceId: workspaceA.id,
              workspaceName: workspaceA.name,
            },
          },
        })),
      } as unknown as ConfigStore;
      vi.stubEnv("COBALT_TOKEN", "token");
      if (source === "environment")
        vi.stubEnv("COBALT_WORKSPACE", workspaceB.name);
      vi.stubGlobal(
        "fetch",
        vi.fn(
          async () =>
            new Response(
              JSON.stringify({
                items: [workspaceA, workspaceB],
                hasMore: false,
              }),
              { headers: { "content-type": "application/json" } },
            ),
        ),
      );

      const context = await new Runtime(
        configStore,
        new MemoryCredentialStore(),
      ).context(source === "cli" ? { workspace: workspaceB.id } : {}, [], true);

      expect(context.workspaceId).toBe(workspaceB.id);
      expect(context.workspaceName).toBe("Override B");
    },
  );
});

describe("allPages", () => {
  it("rejects a repeated cursor instead of looping forever", async () => {
    await expect(
      allPages(
        async () => ({ items: [], hasMore: true, nextCursor: "same" }),
        true,
        () => undefined,
      ),
    ).rejects.toBeInstanceOf(CliError);
  });

  it("stops after one page unless all is requested", async () => {
    let calls = 0;
    await allPages(
      async () => ({
        items: [++calls],
        hasMore: true,
        nextCursor: `page-${calls}`,
      }),
      false,
      () => undefined,
    );
    expect(calls).toBe(1);
  });
});

describe("exact reference resolution", () => {
  it("resolves an exact UUID without accepting a conflicting name", async () => {
    const api = {
      listWorkspaces: async () => ({
        items: [
          workspace(
            "11111111-1111-4111-8111-111111111111",
            "22222222-2222-4222-8222-222222222222",
          ),
          workspace(
            "22222222-2222-4222-8222-222222222222",
            "11111111-1111-4111-8111-111111111111",
          ),
        ],
        hasMore: false,
      }),
    } as unknown as CobaltApiClient;
    await expect(
      resolveWorkspaceItem(api, "11111111-1111-4111-8111-111111111111"),
    ).resolves.toMatchObject({ id: "11111111-1111-4111-8111-111111111111" });
  });

  it("rejects ambiguous names across pages", async () => {
    const api = {
      listRepositories: async (
        _workspaceId: string,
        _limit: number,
        cursor?: string,
      ) =>
        cursor
          ? {
              items: [
                repository("22222222-2222-4222-8222-222222222222", "Shared"),
              ],
              hasMore: false,
            }
          : {
              items: [
                repository("11111111-1111-4111-8111-111111111111", "Shared"),
              ],
              hasMore: true,
              nextCursor: "next",
            },
    } as unknown as CobaltApiClient;
    await expect(
      resolveRepositoryItem(
        api,
        "33333333-3333-4333-8333-333333333333",
        "shared",
      ),
    ).rejects.toMatchObject({ exitCode: 6 });
  });
});

function workspace(id: string, name: string) {
  return { id, name, role: "member", memberCount: 1 };
}
function repository(id: string, displayName: string) {
  return {
    id,
    displayName,
    provider: "github",
    status: "ready",
    taskEligible: true,
  };
}
