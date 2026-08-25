import { afterEach, describe, expect, it, vi } from "vitest";
import { Output, sanitize } from "./output.js";
import { ApiError, CliError, ExitCode, exitCodeForStatus } from "./errors.js";
import { resolveEnvironment } from "./environment.js";

afterEach(() => vi.restoreAllMocks());

describe("sanitize", () => {
  it("replaces terminal controls and bidi formatting characters", () => {
    expect(sanitize("safe\u001b\u202edata")).toBe("safe��data");
  });

  it.each([
    [400, 2],
    [401, 3],
    [403, 4],
    [404, 5],
    [409, 6],
    [429, 7],
    [503, 8],
    [402, 9],
  ])("maps HTTP %i to stable exit code %i", (status, code) => {
    expect(exitCodeForStatus(status)).toBe(code);
  });

  it("buffers all JSON pages into one envelope", () => {
    const writes: string[] = [];
    vi.spyOn(process.stdout, "write").mockImplementation((value) => {
      writes.push(String(value));
      return true;
    });
    const output = new Output(resolveEnvironment("dev"), "json");
    output.result("workspace", [{ id: 1 }]);
    output.result("workspace", [{ id: 2 }]);
    output.complete();
    expect(writes).toHaveLength(1);
    expect(JSON.parse(writes[0]!)).toMatchObject({
      apiVersion: "v1",
      kind: "workspace",
      environment: "dev",
      data: [{ id: 1 }, { id: 2 }],
    });
  });

  it("includes idempotency replay metadata in JSON Lines", () => {
    const writes: string[] = [];
    vi.spyOn(process.stdout, "write").mockImplementation((value) => {
      writes.push(String(value));
      return true;
    });
    const output = new Output(resolveEnvironment("prod"), "jsonl");
    output.result(
      "taskAccepted",
      { taskId: "task" },
      "11111111-1111-4111-8111-111111111111",
      "replayed",
    );
    expect(JSON.parse(writes[0]!)).toMatchObject({
      meta: {
        idempotencyKey: "11111111-1111-4111-8111-111111111111",
        idempotencyOutcome: "replayed",
      },
    });
  });

  it("writes structured local errors only to stderr", () => {
    const stdout = vi
      .spyOn(process.stdout, "write")
      .mockImplementation(() => true);
    const writes: string[] = [];
    vi.spyOn(process.stderr, "write").mockImplementation((value) => {
      writes.push(String(value));
      return true;
    });
    new Output(resolveEnvironment("prod"), "json").error(
      new CliError("bad input", ExitCode.usage),
      ExitCode.usage,
    );
    expect(stdout).not.toHaveBeenCalled();
    expect(JSON.parse(writes[0]!)).toMatchObject({
      status: 400,
      code: "cli_usage",
      exitCode: 2,
      detail: "bad input",
    });
  });

  it("gives human-mode recovery guidance for an ambiguous mutation", () => {
    const writes: string[] = [];
    vi.spyOn(process.stderr, "write").mockImplementation((value) => {
      writes.push(String(value));
      return true;
    });
    const output = new Output(resolveEnvironment("prod"), "human");
    const key = "11111111-1111-4111-8111-111111111111";
    output.beginMutation(key);

    output.error(
      new CliError("The External API is unavailable.", ExitCode.unavailable),
      ExitCode.unavailable,
    );

    expect(writes.join("")).toContain(`--idempotency-key ${key}`);
    expect(writes.join("")).toContain("mutation outcome may be unknown");
  });

  it("does not describe an ordinary validated 4xx as ambiguous", () => {
    const writes: string[] = [];
    vi.spyOn(process.stderr, "write").mockImplementation((value) => {
      writes.push(String(value));
      return true;
    });
    const output = new Output(resolveEnvironment("prod"), "human");
    output.beginMutation("11111111-1111-4111-8111-111111111111");
    const error = new ApiError({
      type: "urn:test",
      title: "Conflict",
      status: 409,
      detail: "The request conflicts with current state.",
      code: "conflict",
      retryable: false,
      traceId: "trace",
      details: {},
    });

    output.error(error, error.exitCode);

    expect(writes.join("")).not.toContain("--idempotency-key");
    expect(writes.join("")).not.toContain("outcome may be unknown");
  });
});
