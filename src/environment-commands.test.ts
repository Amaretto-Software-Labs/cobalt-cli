import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { resolveEnvironment } from "./environment.js";
import { Output } from "./output.js";
import { runProgram } from "./program.js";
import type { Context, Runtime } from "./runtime.js";

const workspace = "11111111-1111-4111-8111-111111111111";
const task = "22222222-2222-4222-8222-222222222222";
const key = "33333333-3333-4333-8333-333333333333";
const environment = "44444444-4444-4444-8444-444444444444";
const attachment = "55555555-5555-4555-8555-555555555555";
const folders: string[] = [];
afterEach(async () => {
  process.exitCode = undefined;
  vi.restoreAllMocks();
  vi.useRealTimers();
  await Promise.all(
    folders
      .splice(0)
      .map((folder) => fs.rm(folder, { recursive: true, force: true })),
  );
});
function setup(api: object = {}) {
  const context = {
    api,
    output: {
      mode: "json",
      result: vi.fn(),
      beginMutation: vi.fn(),
      complete: vi.fn(),
      error: vi.fn(),
    },
    requireWorkspace: () => workspace,
  } as unknown as Context;
  const runtime = { context: vi.fn(async () => context) } as unknown as Runtime;
  return { context, runtime };
}
async function file(body: unknown) {
  const folder = await fs.mkdtemp(
    path.join(os.tmpdir(), "cobalt-environment-test-"),
  );
  folders.push(folder);
  const filename = path.join(folder, "definition.json");
  await fs.writeFile(filename, JSON.stringify(body));
  return filename;
}
const sidecar = {
  id: null,
  label: "db",
  name: "Database",
  image: {
    kind: "registry" as const,
    reference: "docker.io/library/postgres:17",
  },
  cpuCores: 2,
  memoryMiB: 4096,
  rootDiskGiB: 10,
  command: [],
  initializeCommand: null,
  readiness: { kind: "tcp" as const, port: 5432 },
};
const accepted = async () => ({ value: {}, outcome: "created" });

describe("workspace environment command contracts", () => {
  it("reads sidecar diagnostics with read authority and no mutation identity", async () => {
    const response = {
      environmentId: environment,
      sidecarId: attachment,
      status: "blocked",
      failureCode: "probe_failed",
      diagnostics: null,
    };
    const sidecarDiagnostics = vi.fn(async () => response);
    const { runtime, context } = setup({ sidecarDiagnostics });
    expect(
      await runProgram(runtime, [
        "environment",
        "sidecar",
        "diagnostics",
        environment,
        attachment,
      ]),
    ).toBe(0);
    expect(sidecarDiagnostics).toHaveBeenCalledWith(environment, attachment);
    expect(context.output.result).toHaveBeenCalledWith(
      "sidecarDiagnostics",
      response,
    );
    expect(context.output.beginMutation).not.toHaveBeenCalled();
    expect(runtime.context).toHaveBeenCalledWith(
      expect.anything(),
      ["cobaltcode.external.read"],
      true,
    );
  });
  it.each(["vm-db", "ns", "hostmaster"])(
    "rejects reserved service label %s before transport",
    async (label) => {
      const createEnvironment = vi.fn(accepted);
      const { runtime } = setup({ createEnvironment });
      expect(
        await runProgram(runtime, [
          "environment",
          "create",
          "--definition-file",
          await file({
            name: "Database",
            description: null,
            sidecars: [{ ...sidecar, label }],
          }),
        ]),
      ).toBe(2);
      expect(createEnvironment).not.toHaveBeenCalled();
    },
  );
  it("rejects interpolation in connection binding values", async () => {
    const attachTaskEnvironment = vi.fn(accepted);
    const { runtime } = setup({ attachTaskEnvironment });
    expect(
      await runProgram(runtime, [
        "task",
        "environment",
        "attach",
        task,
        environment,
        "--bindings-file",
        await file({ DATABASE_HOST: "${db.host}" }),
      ]),
    ).toBe(2);
    expect(attachTaskEnvironment).not.toHaveBeenCalled();
  });
  it("waits for the same operation using metadata reads and no mutation", async () => {
    vi.useFakeTimers();
    const getEnvironmentOperation = vi
      .fn()
      .mockResolvedValueOnce({ id: key, status: "pending" })
      .mockResolvedValueOnce({ id: key, status: "succeeded" });
    const { runtime, context } = setup({ getEnvironmentOperation });
    const execution = runProgram(runtime, [
      "environment",
      "operation",
      key,
      "--wait",
      "--timeout",
      "3",
    ]);
    await vi.advanceTimersByTimeAsync(1000);
    expect(await execution).toBe(0);
    expect(getEnvironmentOperation).toHaveBeenNthCalledWith(
      1,
      key,
      expect.any(AbortSignal),
    );
    expect(getEnvironmentOperation).toHaveBeenNthCalledWith(
      2,
      key,
      expect.any(AbortSignal),
    );
    expect(context.output.beginMutation).not.toHaveBeenCalled();
    expect(runtime.context).toHaveBeenCalledWith(
      expect.anything(),
      ["cobaltcode.external.read"],
      true,
    );
  });
  it("reports terminal operation failure without retrying a mutation", async () => {
    const getEnvironmentOperation = vi.fn(async () => ({
      id: key,
      status: "cancelled",
      failureCode: "environment_generation_conflict",
    }));
    const { runtime, context } = setup({ getEnvironmentOperation });
    expect(
      await runProgram(runtime, ["environment", "operation", key, "--wait"]),
    ).toBe(6);
    expect(getEnvironmentOperation).toHaveBeenCalledOnce();
    expect(context.output.result).toHaveBeenCalledWith(
      "environmentOperation",
      expect.objectContaining({ status: "cancelled" }),
    );
    expect(context.output.beginMutation).not.toHaveBeenCalled();
  });
  it("bounds operation waiting and retains the operation identity on timeout", async () => {
    vi.useFakeTimers();
    const getEnvironmentOperation = vi.fn(async () => ({
      id: key,
      status: "pending",
    }));
    const { runtime, context } = setup({ getEnvironmentOperation });
    const execution = runProgram(runtime, [
      "environment",
      "operation",
      key,
      "--wait",
      "--timeout",
      "1",
    ]);
    await vi.advanceTimersByTimeAsync(1000);
    expect(await execution).toBe(8);
    expect(context.output.result).toHaveBeenCalledWith("environmentOperation", {
      id: key,
      status: "pending",
    });
    expect(context.output.beginMutation).not.toHaveBeenCalled();
  });
  it("creates a complete definition with create scope and one replay key", async () => {
    const definition = {
      name: "Database",
      description: null,
      sidecars: [sidecar],
      authorizeService: true,
    };
    const createEnvironment = vi.fn(accepted);
    const { runtime } = setup({ createEnvironment });
    expect(
      await runProgram(runtime, [
        "environment",
        "create",
        "--definition-file",
        await file(definition),
        "--idempotency-key",
        key,
      ]),
    ).toBe(0);
    expect(createEnvironment).toHaveBeenCalledWith(workspace, definition, key);
    expect(runtime.context).toHaveBeenCalledWith(
      expect.anything(),
      ["cobaltcode.external.create"],
      true,
    );
  });
  it("rejects plaintext environment fields before transport", async () => {
    const createEnvironment = vi.fn(accepted);
    const { runtime, context } = setup({ createEnvironment });
    expect(
      await runProgram(runtime, [
        "environment",
        "create",
        "--definition-file",
        await file({
          name: "Db",
          sidecars: [sidecar],
          environment: { PASSWORD: "never-echo-this" },
        }),
      ]),
    ).toBe(2);
    expect(createEnvironment).not.toHaveBeenCalled();
    expect(
      JSON.stringify(vi.mocked(context.output.error).mock.calls),
    ).not.toContain("never-echo-this");
  });
  it.each(["0", "-1", "1.5", "1e2", "9007199254740992"])(
    "rejects invalid generation %s before authorization",
    async (value) => {
      vi.spyOn(process.stderr, "write").mockImplementation(() => true);
      const { runtime } = setup();
      expect(
        await runProgram(runtime, [
          "environment",
          "stop",
          environment,
          "--expected-generation",
          value,
        ]),
      ).toBe(2);
      expect(runtime.context).not.toHaveBeenCalled();
    },
  );
  it.each(["start", "stop", "restart", "delete", "revoke-service"])(
    "sends generation and key for %s",
    async (action) => {
      const environmentAction = vi.fn(accepted);
      const { runtime } = setup({ environmentAction });
      expect(
        await runProgram(runtime, [
          "environment",
          action,
          environment,
          "--expected-generation",
          "7",
          "--idempotency-key",
          key,
        ]),
      ).toBe(0);
      expect(environmentAction).toHaveBeenCalledWith(
        environment,
        action.replace("-", "_"),
        7,
        key,
      );
    },
  );
  it("attaches without waking directly and preserves explicit bindings", async () => {
    const attachTaskEnvironment = vi.fn(accepted);
    const { runtime } = setup({ attachTaskEnvironment });
    const bindings = { DATABASE_HOST: "db" };
    expect(
      await runProgram(runtime, [
        "task",
        "environment",
        "attach",
        task,
        environment,
        "--bindings-file",
        await file(bindings),
        "--idempotency-key",
        key,
      ]),
    ).toBe(0);
    expect(attachTaskEnvironment).toHaveBeenCalledWith(
      task,
      environment,
      bindings,
      key,
    );
  });
  it("sets and clears DNS only with an explicit selection and task generation", async () => {
    const setTaskEnvironmentDnsDefault = vi.fn(accepted);
    const { runtime } = setup({ setTaskEnvironmentDnsDefault });
    for (const args of [[], ["--clear", "--attachment", attachment]])
      expect(
        await runProgram(runtime, [
          "task",
          "environment",
          "dns-default",
          task,
          "--expected-generation",
          "9",
          ...args,
        ]),
      ).toBe(2);
    expect(setTaskEnvironmentDnsDefault).not.toHaveBeenCalled();
    process.exitCode = undefined;
    expect(
      await runProgram(runtime, [
        "task",
        "environment",
        "dns-default",
        task,
        "--expected-generation",
        "9",
        "--clear",
        "--idempotency-key",
        key,
      ]),
    ).toBe(0);
    expect(setTaskEnvironmentDnsDefault).toHaveBeenCalledWith(
      task,
      null,
      9,
      key,
    );
    expect(
      await runProgram(runtime, [
        "task",
        "environment",
        "dns-default",
        task,
        "--expected-generation",
        "10",
        "--attachment",
        attachment,
        "--idempotency-key",
        key,
      ]),
    ).toBe(0);
    expect(setTaskEnvironmentDnsDefault).toHaveBeenLastCalledWith(
      task,
      attachment,
      10,
      key,
    );
  });
  it("creates a task with an environment and explicit default", async () => {
    const createTask = vi.fn(accepted);
    const listAgents = vi.fn(async () => ({
      items: [
        {
          id: workspace,
          label: "Default",
          status: "ready",
          isDefault: true,
          models: [],
        },
      ],
      hasMore: false,
    }));
    const { runtime } = setup({ createTask, listAgents });
    expect(
      await runProgram(runtime, [
        "task",
        "create",
        "--message",
        "hello",
        "--attach-environment",
        environment,
        attachment,
        "--default-dns-environment",
        attachment,
        "--idempotency-key",
        key,
      ]),
    ).toBe(0);
    expect(createTask).toHaveBeenCalledWith(
      workspace,
      expect.objectContaining({
        environmentIds: [environment, attachment],
        defaultDnsEnvironmentId: attachment,
      }),
      key,
    );
  });
  it("rejects duplicate environment IDs and a DNS default outside the selected set", async () => {
    const createTask = vi.fn(accepted);
    const { runtime } = setup({ createTask });
    for (const args of [
      [environment, environment],
      [environment, "--default-dns-environment", attachment],
    ])
      expect(
        await runProgram(runtime, [
          "task",
          "create",
          "--message",
          "hello",
          "--attach-environment",
          ...args,
        ]),
      ).toBe(2);
    expect(createTask).not.toHaveBeenCalled();
  });
  it("sends normally for a task with environment attachments", async () => {
    const sendMessage = vi.fn(accepted);
    const { runtime } = setup({ sendMessage });
    expect(
      await runProgram(runtime, [
        "task",
        "send",
        task,
        "--message",
        "hello",
        "--idempotency-key",
        key,
      ]),
    ).toBe(0);
    expect(sendMessage).toHaveBeenCalledWith(task, { message: "hello" }, key);
  });
});

describe("environment operation structured failure output", () => {
  function structuredSetup(getEnvironmentOperation: unknown) {
    const { runtime, context } = setup({ getEnvironmentOperation });
    context.output = new Output(resolveEnvironment("prod"), "json");
    const stdout = vi
      .spyOn(process.stdout, "write")
      .mockImplementation(() => true);
    const stderr = vi
      .spyOn(process.stderr, "write")
      .mockImplementation(() => true);
    return { runtime, stdout, stderr };
  }

  it.each(["failed", "cancelled", "superseded"])(
    "prints the complete %s observation before returning a conflict",
    async (status) => {
      const observation = {
        id: key,
        environmentId: environment,
        generation: 7,
        status,
        failureCode: "probe_failed",
      };
      const getEnvironmentOperation = vi.fn(async () => observation);
      const { runtime, stdout, stderr } = structuredSetup(
        getEnvironmentOperation,
      );
      expect(
        await runProgram(runtime, [
          "environment",
          "operation",
          key,
          "--wait",
          "--json",
        ]),
      ).toBe(6);
      expect(stdout).toHaveBeenCalledOnce();
      expect(JSON.parse(String(stdout.mock.calls[0]![0]))).toMatchObject({
        kind: "environmentOperation",
        data: observation,
      });
      expect(JSON.parse(String(stderr.mock.calls[0]![0]))).toMatchObject({
        exitCode: 6,
      });
      expect(getEnvironmentOperation).toHaveBeenCalledOnce();
    },
  );

  it("prints the last observation when the wait deadline expires", async () => {
    vi.useFakeTimers();
    const observation = {
      id: key,
      environmentId: environment,
      generation: 7,
      status: "running",
      failureCode: null,
    };
    const { runtime, stdout, stderr } = structuredSetup(
      vi.fn(async () => observation),
    );
    const execution = runProgram(runtime, [
      "environment",
      "operation",
      key,
      "--wait",
      "--timeout",
      "1",
      "--json",
    ]);
    await vi.advanceTimersByTimeAsync(1000);
    expect(await execution).toBe(8);
    expect(stdout).toHaveBeenCalledOnce();
    expect(JSON.parse(String(stdout.mock.calls[0]![0]))).toMatchObject({
      kind: "environmentOperation",
      data: observation,
    });
    expect(JSON.parse(String(stderr.mock.calls[0]![0]))).toMatchObject({
      exitCode: 8,
    });
  });

  it("prints the last observation when an in-flight poll times out", async () => {
    vi.useFakeTimers();
    const controller = new AbortController();
    vi.spyOn(AbortSignal, "timeout").mockReturnValue(controller.signal);
    const observation = {
      id: key,
      environmentId: environment,
      generation: 7,
      status: "pending",
      failureCode: null,
    };
    const getEnvironmentOperation = vi
      .fn()
      .mockResolvedValueOnce(observation)
      .mockImplementationOnce(async () => {
        controller.abort(new DOMException("Timed out", "TimeoutError"));
        throw controller.signal.reason;
      });
    const { runtime, stdout, stderr } = structuredSetup(
      getEnvironmentOperation,
    );
    const execution = runProgram(runtime, [
      "environment",
      "operation",
      key,
      "--wait",
      "--timeout",
      "3",
      "--json",
    ]);
    await vi.advanceTimersByTimeAsync(1000);
    expect(await execution).toBe(8);
    expect(stdout).toHaveBeenCalledOnce();
    expect(JSON.parse(String(stdout.mock.calls[0]![0]))).toMatchObject({
      kind: "environmentOperation",
      data: observation,
    });
    expect(JSON.parse(String(stderr.mock.calls[0]![0]))).toMatchObject({
      exitCode: 8,
    });
  });

  it("prints successful completion once with no error", async () => {
    const observation = {
      id: key,
      generation: 7,
      status: "succeeded",
      failureCode: null,
    };
    const { runtime, stdout, stderr } = structuredSetup(
      vi.fn(async () => observation),
    );
    expect(
      await runProgram(runtime, [
        "environment",
        "operation",
        key,
        "--wait",
        "--json",
      ]),
    ).toBe(0);
    expect(stdout).toHaveBeenCalledOnce();
    expect(JSON.parse(String(stdout.mock.calls[0]![0]))).toMatchObject({
      kind: "environmentOperation",
      data: observation,
    });
    expect(stderr).not.toHaveBeenCalled();
  });
});
