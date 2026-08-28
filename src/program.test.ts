import { afterEach, describe, expect, it, vi } from "vitest";
import { createProgram, runProgram } from "./program.js";
import { CliError, ExitCode, UsageError } from "./errors.js";
import { Output } from "./output.js";
import type { Context, Runtime } from "./runtime.js";

afterEach(() => {
  process.exitCode = undefined;
  vi.restoreAllMocks();
});

describe("command catalog", () => {
  it("preserves all public Cobalt command paths", () => {
    const program = createProgram({} as Runtime);
    const paths: string[] = [];
    const visit = (command: typeof program, prefix = "") => {
      for (const child of command.commands) {
        const path = `${prefix}${child.name()}`;
        paths.push(path);
        visit(child, `${path} `);
      }
    };
    visit(program);
    expect(paths.sort()).toEqual(
      [
        "agent",
        "agent list",
        "auth",
        "auth login",
        "auth logout",
        "auth status",
        "completion",
        "interactive",
        "repo",
        "repo list",
        "task",
        "task cancel",
        "task create",
        "task delete",
        "task events",
        "task follow",
        "task get",
        "task list",
        "task message-search",
        "task messages",
        "task open",
        "task resume",
        "task search",
        "task send",
        "task steer",
        "task suspend",
        "task wait",
        "version",
        "workspace",
        "workspace current",
        "workspace list",
        "workspace use",
      ].sort(),
    );
  });

  it.each([
    ["--json"],
    ["--jsonl"],
    ["--quiet"],
    ["--idempotency-key", "11111111-1111-4111-8111-111111111111"],
  ])(
    "rejects interactive mode with global automation option %s",
    async (...option) => {
      vi.spyOn(process.stderr, "write").mockImplementation(() => true);
      const context = fakeContext();
      const runtime = {
        context: vi.fn(async () => context),
      } as unknown as Runtime;
      await expect(
        runProgram(runtime, ["interactive", ...option]),
      ).resolves.toBe(2);
      if (option[0] === "--idempotency-key")
        expect(runtime.context).not.toHaveBeenCalled();
      else expect(context.output.error).toHaveBeenCalled();
    },
  );

  it("normalizes wait UUIDs before enforcing uniqueness", async () => {
    const context = fakeContext();
    const runtime = {
      context: vi.fn(async () => context),
    } as unknown as Runtime;
    const id = "AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA";
    await expect(
      runProgram(runtime, ["task", "wait", id, id.toLowerCase()]),
    ).resolves.toBe(2);
    expect(context.api.getTask).not.toHaveBeenCalled();
  });

  it("reports the effective workspace override instead of saved context", async () => {
    const workspaceB = "22222222-2222-4222-8222-222222222222";
    const stdout: string[] = [];
    vi.spyOn(process.stdout, "write").mockImplementation((value) => {
      stdout.push(String(value));
      return true;
    });
    const context = fakeContext();
    context.workspaceId = workspaceB;
    context.workspaceName = "Override B";
    context.config.environments.prod = {
      workspaceId: "11111111-1111-4111-8111-111111111111",
      workspaceName: "Saved A",
    };
    context.output = new Output(context.environment, "json");
    const runtime = {
      context: vi.fn(async () => context),
    } as unknown as Runtime;

    await expect(
      runProgram(runtime, [
        "--json",
        "--workspace",
        workspaceB,
        "workspace",
        "current",
      ]),
    ).resolves.toBe(0);

    expect(JSON.parse(stdout[0]!)).toMatchObject({
      kind: "workspaceContext",
      data: { workspaceId: workspaceB, workspaceName: "Override B" },
    });
  });

  it("emits one structured parser failure and no stdout", async () => {
    const stdout = vi
      .spyOn(process.stdout, "write")
      .mockImplementation(() => true);
    const stderr: string[] = [];
    vi.spyOn(process.stderr, "write").mockImplementation((value) => {
      stderr.push(String(value));
      return true;
    });
    await expect(
      runProgram({} as Runtime, ["--json", "unknown-command"]),
    ).resolves.toBe(2);
    expect(stdout).not.toHaveBeenCalled();
    expect(stderr).toHaveLength(1);
    expect(JSON.parse(stderr[0]!)).toMatchObject({
      code: "cli_usage",
      exitCode: 2,
    });
  });

  it("routes an invalid completion shell through structured usage handling", async () => {
    const stdout = vi
      .spyOn(process.stdout, "write")
      .mockImplementation(() => true);
    const stderr: string[] = [];
    vi.spyOn(process.stderr, "write").mockImplementation((value) => {
      stderr.push(String(value));
      return true;
    });

    await expect(
      runProgram({} as Runtime, ["--json", "completion", "invalid"]),
    ).resolves.toBe(ExitCode.usage);

    expect(stdout).not.toHaveBeenCalled();
    expect(stderr).toHaveLength(1);
    expect(JSON.parse(stderr[0]!)).toMatchObject({
      code: "cli_usage",
      exitCode: 2,
      detail: "Shell must be one of: bash, zsh, fish, powershell.",
    });
  });

  it("uses the usage exit code when environment resolution fails", async () => {
    const stderr: string[] = [];
    vi.spyOn(process.stderr, "write").mockImplementation((value) => {
      stderr.push(String(value));
      return true;
    });
    const runtime = {
      context: vi.fn(async () => {
        throw new UsageError("Environment must be one of: prod, dev, demo.");
      }),
    } as unknown as Runtime;

    await expect(
      runProgram(runtime, [
        "auth",
        "status",
        "--environment",
        "unknown",
        "--json",
      ]),
    ).resolves.toBe(2);
    expect(JSON.parse(stderr.at(-1)!)).toMatchObject({
      environment: "prod",
      code: "cli_usage",
      exitCode: 2,
    });
  });

  it("rejects idempotency keys on read commands before API access", async () => {
    vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const runtime = { context: vi.fn() } as unknown as Runtime;
    await expect(
      runProgram(runtime, [
        "task",
        "get",
        "11111111-1111-4111-8111-111111111111",
        "--idempotency-key",
        "22222222-2222-4222-8222-222222222222",
      ]),
    ).resolves.toBe(2);
    expect(runtime.context).not.toHaveBeenCalled();
  });

  it("reports the generated retry key after an ambiguous mutation", async () => {
    const writes: string[] = [];
    vi.spyOn(process.stderr, "write").mockImplementation((value) => {
      writes.push(String(value));
      return true;
    });
    const context = fakeContext();
    context.output = new Output(context.environment, "human");
    let generatedKey: string | undefined;
    context.api = {
      cancelTurn: vi.fn(async (_taskId: string, key: string) => {
        generatedKey = key;
        throw new CliError(
          "The External API is unavailable after the retry budget.",
          ExitCode.unavailable,
        );
      }),
    } as unknown as Context["api"];
    const runtime = {
      context: vi.fn(async () => context),
    } as unknown as Runtime;

    await expect(
      runProgram(runtime, [
        "task",
        "cancel",
        "11111111-1111-4111-8111-111111111111",
      ]),
    ).resolves.toBe(ExitCode.unavailable);

    expect(generatedKey).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
    expect(writes.join("")).toContain(`--idempotency-key ${generatedKey}`);
  });

  it("accepts a non-nil idempotency UUID whose first field is zero", async () => {
    const key = "00000000-1111-4111-8111-111111111111";
    const context = fakeContext();
    context.output = new Output(context.environment, "human", true);
    vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    context.api = {
      cancelTurn: vi.fn(async () => ({
        value: { taskId: "11111111-1111-4111-8111-111111111111" },
      })),
    } as unknown as Context["api"];
    const runtime = {
      context: vi.fn(async () => context),
    } as unknown as Runtime;

    await expect(
      runProgram(runtime, [
        "task",
        "cancel",
        "11111111-1111-4111-8111-111111111111",
        "--idempotency-key",
        key,
      ]),
    ).resolves.toBe(0);

    expect(context.api.cancelTurn).toHaveBeenCalledWith(
      "11111111-1111-4111-8111-111111111111",
      key,
    );
  });

  it("routes task delete through the idempotent mutation path", async () => {
    const key = "22222222-2222-4222-8222-222222222222";
    const taskId = "11111111-1111-4111-8111-111111111111";
    const context = fakeContext();
    context.output = new Output(context.environment, "human", true);
    vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    context.api = {
      deleteTask: vi.fn(async () => ({
        value: { taskId, status: "accepted" },
      })),
    } as unknown as Context["api"];
    const runtime = {
      context: vi.fn(async () => context),
    } as unknown as Runtime;

    await expect(
      runProgram(runtime, ["task", "delete", taskId, "--idempotency-key", key]),
    ).resolves.toBe(0);

    expect(context.api.deleteTask).toHaveBeenCalledWith(taskId, key);
  });

  it("rejects the nil UUID as an idempotency key", async () => {
    const context = fakeContext();
    context.api = { cancelTurn: vi.fn() } as unknown as Context["api"];
    const runtime = {
      context: vi.fn(async () => context),
    } as unknown as Runtime;
    vi.spyOn(process.stderr, "write").mockImplementation(() => true);

    await expect(
      runProgram(runtime, [
        "task",
        "cancel",
        "11111111-1111-4111-8111-111111111111",
        "--idempotency-key",
        "00000000-0000-0000-0000-000000000000",
      ]),
    ).resolves.toBe(ExitCode.usage);

    expect(context.api.cancelTurn).not.toHaveBeenCalled();
  });

  it("generates the complete canonical vocabulary for every shell", async () => {
    const writes: string[] = [];
    vi.spyOn(process.stdout, "write").mockImplementation((value) => {
      writes.push(String(value));
      return true;
    });
    for (const shell of ["bash", "zsh", "fish", "powershell", "BASH"])
      await runProgram({} as Runtime, ["completion", shell]);
    expect(writes).toHaveLength(5);
    for (const script of writes) {
      expect(script).toContain("version");
      expect(script).toContain("message-search");
      expect(script).toContain("delete");
    }
  });

  it("reports the same version through the option and command", async () => {
    const writes: string[] = [];
    vi.spyOn(process.stdout, "write").mockImplementation((value) => {
      writes.push(String(value));
      return true;
    });
    await runProgram({} as Runtime, ["--version"]);
    await runProgram({} as Runtime, ["version"]);
    expect(writes).toHaveLength(2);
    expect(writes[0]).toBe(writes[1]);
    expect(writes[0]).toMatch(/^0\.1\.0\n$/);
  });

  it("uses one deadline signal for every follow read and wait", async () => {
    const taskId = "11111111-1111-4111-8111-111111111111";
    const signals: (AbortSignal | undefined)[] = [];
    const context = fakeContext();
    context.output = new Output(context.environment, "jsonl");
    context.api = {
      getTask: vi.fn(async (_taskId: string, signal?: AbortSignal) => {
        signals.push(signal);
        return { lastEventSequence: 0 };
      }),
      listEvents: vi.fn(
        async (
          _taskId: string,
          _after: number,
          _limit: number,
          signal?: AbortSignal,
        ) => {
          signals.push(signal);
          return { items: [], hasMore: false };
        },
      ),
      waitForTasks: vi.fn(async (_body: object, signal?: AbortSignal) => {
        signals.push(signal);
        return { tasks: [{ status: "ready" }] };
      }),
    } as unknown as Context["api"];
    const runtime = {
      context: vi.fn(async () => context),
    } as unknown as Runtime;
    vi.spyOn(process.stdout, "write").mockImplementation(() => true);

    await expect(
      runProgram(runtime, [
        "--jsonl",
        "task",
        "follow",
        taskId,
        "--after-sequence",
        "0",
        "--timeout",
        "1s",
      ]),
    ).resolves.toBe(0);

    expect(signals).toHaveLength(4);
    expect(signals[0]).toBeInstanceOf(AbortSignal);
    expect(signals.every((signal) => signal === signals[0])).toBe(true);
  });

  it("reports a deadline during event reading as a timed-out follow", async () => {
    const taskId = "11111111-1111-4111-8111-111111111111";
    const stdout: string[] = [];
    vi.spyOn(process.stdout, "write").mockImplementation((value) => {
      stdout.push(String(value));
      return true;
    });
    const context = fakeContext();
    context.output = new Output(context.environment, "jsonl");
    context.api = {
      getTask: vi.fn(async () => ({ lastEventSequence: 0 })),
      listEvents: vi.fn(
        async (
          _taskId: string,
          _after: number,
          _limit: number,
          signal?: AbortSignal,
        ) =>
          await new Promise((_resolve, reject) => {
            const abort = () => reject(signal?.reason);
            signal?.addEventListener("abort", abort, { once: true });
            if (signal?.aborted) abort();
          }),
      ),
      waitForTasks: vi.fn(),
    } as unknown as Context["api"];
    const runtime = {
      context: vi.fn(async () => context),
    } as unknown as Runtime;

    await expect(
      runProgram(runtime, [
        "--jsonl",
        "task",
        "follow",
        taskId,
        "--after-sequence",
        "0",
        "--timeout",
        "1ms",
      ]),
    ).resolves.toBe(0);

    expect(context.api.waitForTasks).not.toHaveBeenCalled();
    expect(JSON.parse(stdout.at(-1)!)).toMatchObject({
      kind: "followEnd",
      data: { taskId, lastEventSequence: 0, timedOut: true },
    });
  });

  it("reports a deadline during cold OAuth refresh as a timed-out follow", async () => {
    const taskId = "11111111-1111-4111-8111-111111111111";
    const stdout: string[] = [];
    vi.spyOn(process.stdout, "write").mockImplementation((value) => {
      stdout.push(String(value));
      return true;
    });
    const context = fakeContext();
    context.output = new Output(context.environment, "jsonl");
    context.api = {
      getTask: vi.fn(
        async (_taskId: string, signal?: AbortSignal) =>
          await new Promise((_resolve, reject) => {
            const abort = () =>
              reject(
                new CliError(
                  "Authentication was interrupted.",
                  ExitCode.interrupted,
                ),
              );
            signal?.addEventListener("abort", abort, { once: true });
            if (signal?.aborted) abort();
          }),
      ),
    } as unknown as Context["api"];
    const runtime = {
      context: vi.fn(async () => context),
    } as unknown as Runtime;

    await expect(
      runProgram(runtime, [
        "--jsonl",
        "task",
        "follow",
        taskId,
        "--timeout",
        "1ms",
      ]),
    ).resolves.toBe(0);

    expect(JSON.parse(stdout.at(-1)!)).toMatchObject({
      kind: "followEnd",
      data: { taskId, lastEventSequence: 0, timedOut: true },
    });
  });

  it("accepts the largest safe follow timer duration", async () => {
    const context = fakeContext();
    context.api = {
      getTask: vi.fn(async () => ({ lastEventSequence: 0 })),
      listEvents: vi.fn(async () => ({ items: [], hasMore: false })),
      waitForTasks: vi.fn(async () => ({
        tasks: [{ status: "ready" }],
      })),
    } as unknown as Context["api"];
    const runtime = {
      context: vi.fn(async () => context),
    } as unknown as Runtime;

    await expect(
      runProgram(runtime, [
        "task",
        "follow",
        "11111111-1111-4111-8111-111111111111",
        "--timeout",
        "2147483647ms",
      ]),
    ).resolves.toBe(0);
  });

  it.each(["2147483648ms", "999999999999999999999h"])(
    "rejects unsafe follow timer duration %s as usage",
    async (duration) => {
      const runtime = { context: vi.fn() } as unknown as Runtime;
      vi.spyOn(process.stderr, "write").mockImplementation(() => true);

      await expect(
        runProgram(runtime, [
          "task",
          "follow",
          "11111111-1111-4111-8111-111111111111",
          "--timeout",
          duration,
        ]),
      ).resolves.toBe(ExitCode.usage);

      expect(runtime.context).not.toHaveBeenCalled();
    },
  );
});

function fakeContext(): Context {
  return {
    environment: {
      name: "prod",
      apiBase: new URL("https://api.cobaltcode.ai/v1"),
      oauthResource: new URL("https://api.cobaltcode.ai"),
      identityIssuer: new URL("https://identity.cobaltcode.ai"),
      webFrontend: new URL("https://app.cobaltcode.ai"),
      clientId: "cobalt-cli-prod",
    },
    config: { schemaVersion: 1, currentEnvironment: "prod", environments: {} },
    configStore: {} as Context["configStore"],
    credentialStore: {} as Context["credentialStore"],
    tokenProvider: {} as Context["tokenProvider"],
    api: { getTask: vi.fn() } as unknown as Context["api"],
    output: {
      mode: "human",
      error: vi.fn(),
      complete: vi.fn(),
    } as unknown as Context["output"],
    requireWorkspace: () => "11111111-1111-4111-8111-111111111111",
  };
}
