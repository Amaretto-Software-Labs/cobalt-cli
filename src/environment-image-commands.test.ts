import { afterEach, describe, expect, it, vi } from "vitest";
import { runProgram } from "./program.js";
import type { Context, Runtime } from "./runtime.js";
import {
  environmentImageSourceRequestSchema,
  sidecarImageSchema,
} from "./api-environment-schemas.js";

const workspace = "11111111-1111-4111-8111-111111111111";
const source = "22222222-2222-4222-8222-222222222222";
const entry = "33333333-3333-4333-8333-333333333333";
const key = "44444444-4444-4444-8444-444444444444";
function setup(api: object) {
  const context = {
    api,
    requireWorkspace: () => workspace,
    output: {
      mode: "json",
      result: vi.fn(),
      beginMutation: vi.fn(),
      error: vi.fn(),
      complete: vi.fn(),
    },
  } as unknown as Context;
  return {
    context,
    runtime: { context: vi.fn(async () => context) } as unknown as Runtime,
  };
}
afterEach(() => {
  process.exitCode = undefined;
  vi.restoreAllMocks();
});
describe("environment image commands", () => {
  it("creates a workspace source using a Vault reference and create scope", async () => {
    const createEnvironmentImageSource = vi.fn(async () => ({
      value: { id: source },
      outcome: "created",
    }));
    const { runtime } = setup({ createEnvironmentImageSource });
    expect(
      await runProgram(runtime, [
        "environment",
        "image-source",
        "create",
        "--name",
        "Private GHCR",
        "--registry",
        "ghcr.io",
        "--username",
        "builder",
        "--credential-entry",
        entry,
        "--idempotency-key",
        key,
      ]),
    ).toBe(0);
    expect(createEnvironmentImageSource).toHaveBeenCalledWith(
      workspace,
      {
        name: "Private GHCR",
        registryHost: "ghcr.io",
        username: "builder",
        credentialEntryId: entry,
      },
      key,
    );
    expect(runtime.context).toHaveBeenCalledWith(
      expect.anything(),
      ["cobaltcode.external.create"],
      true,
    );
  });
  it("passes current generation and original request identity when deleting a source", async () => {
    const deleteEnvironmentImageSource = vi.fn(async () => ({
      value: { id: source },
      outcome: "created",
    }));
    const { runtime } = setup({ deleteEnvironmentImageSource });
    expect(
      await runProgram(runtime, [
        "environment",
        "image-source",
        "delete",
        source,
        "--expected-generation",
        "3",
        "--idempotency-key",
        key,
      ]),
    ).toBe(0);
    expect(deleteEnvironmentImageSource).toHaveBeenCalledWith(source, 3, key);
  });
  it("lists registry tags without beginning a mutation", async () => {
    const listEnvironmentImageTags = vi.fn(async () => ({ tags: ["17"] }));
    const { runtime, context } = setup({ listEnvironmentImageTags });
    expect(
      await runProgram(runtime, [
        "environment",
        "image-source",
        "tags",
        source,
        "team/postgres",
        "--cursor",
        "page-2",
      ]),
    ).toBe(0);
    expect(listEnvironmentImageTags).toHaveBeenCalledWith(
      source,
      "team/postgres",
      "page-2",
    );
    expect(context.output.beginMutation).not.toHaveBeenCalled();
  });
  it("does not accept plaintext credentials or credential-bearing archive URLs", () => {
    expect(
      environmentImageSourceRequestSchema.safeParse({
        name: "Registry",
        registryHost: "ghcr.io",
        username: "user",
        credentialEntryId: entry,
        secret: "private",
      }).success,
    ).toBe(false);
    expect(
      sidecarImageSchema.safeParse({
        kind: "archive",
        reference: "https://user:password@example.com/image.tar",
      }).success,
    ).toBe(false);
    expect(
      sidecarImageSchema.safeParse({
        kind: "archive",
        reference: "https://example.com/image.tar",
        sourceId: source,
      }).success,
    ).toBe(false);
    expect(
      sidecarImageSchema.safeParse({
        kind: "archive",
        reference: "https://example.com/image.tar",
      }).success,
    ).toBe(true);
  });
});
