import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { runProgram } from "./program.js";
import type { Context, Runtime } from "./runtime.js";

const workspace = "11111111-1111-4111-8111-111111111111";
const task = "22222222-2222-4222-8222-222222222222";
const key = "33333333-3333-4333-8333-333333333333";
const folders: string[] = [];
afterEach(async () => {
  process.exitCode = undefined;
  vi.restoreAllMocks();
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
async function documentFile(content: string) {
  const folder = await fs.mkdtemp(
    path.join(os.tmpdir(), "cobalt-process-test-"),
  );
  folders.push(folder);
  const file = path.join(folder, "definition.md");
  await fs.writeFile(file, content);
  return file;
}

describe("process command contracts", () => {
  it.each([
    ["loop", "update", task, "--document-file", "definition.md"],
    ["loop", "enable", task],
    [
      "role",
      "update",
      "reviewer",
      "--name",
      "Reviewer",
      "--description",
      "Review",
      "--instructions-file",
      "role.md",
    ],
    ["task", "resume", task, "--role", "reviewer"],
  ])(
    "rejects missing concurrency or unsupported resume arguments: %j",
    async (...args) => {
      vi.spyOn(process.stderr, "write").mockImplementation(() => true);
      const { runtime } = setup();
      expect(await runProgram(runtime, args)).toBe(2);
      expect(runtime.context).not.toHaveBeenCalled();
    },
  );
  it("sends the complete Loop document, expected version and stable request key", async () => {
    const document = "---\nname: Review\n---\nReview the complete diff.\n";
    const updateLoop = vi.fn(async () => ({
      value: { loop: { id: task, definitionVersion: 8 } },
      outcome: "created",
    }));
    const { runtime, context } = setup({ updateLoop });
    expect(
      await runProgram(runtime, [
        "loop",
        "update",
        task,
        "--document-file",
        await documentFile(document),
        "--expected-version",
        "7",
        "--idempotency-key",
        key,
      ]),
    ).toBe(0);
    expect(updateLoop).toHaveBeenCalledWith(workspace, task, document, 7, key);
    expect(runtime.context).toHaveBeenCalledWith(
      expect.anything(),
      ["cobaltcode.external.operate"],
      true,
    );
    expect(context.output.result).toHaveBeenCalledWith(
      "loop",
      { loop: { id: task, definitionVersion: 8 } },
      key,
      "created",
    );
  });
  it("keeps worker role updates complete and version checked", async () => {
    const updateWorkerRole = vi.fn(async () => ({
      value: { key: "reviewer", revision: 3 },
    }));
    const { runtime } = setup({ updateWorkerRole });
    expect(
      await runProgram(runtime, [
        "role",
        "update",
        "reviewer",
        "--name",
        "Reviewer",
        "--description",
        "Review",
        "--instructions-file",
        await documentFile("Exact instructions\n"),
        "--expected-revision",
        "2",
        "--idempotency-key",
        key,
      ]),
    ).toBe(0);
    expect(updateWorkerRole).toHaveBeenCalledWith(
      workspace,
      "reviewer",
      {
        name: "Reviewer",
        description: "Review",
        instructions: "Exact instructions\n",
        expectedRevision: 2,
      },
      key,
    );
  });
  it("drains role pages only when all is requested", async () => {
    const listWorkerRoles = vi
      .fn()
      .mockResolvedValueOnce({
        items: [{ key: "a" }],
        hasMore: true,
        nextCursor: "a",
      })
      .mockResolvedValueOnce({ items: [{ key: "z" }], hasMore: false });
    const { runtime } = setup({ listWorkerRoles });
    expect(
      await runProgram(runtime, ["role", "list", "--all", "--limit", "1"]),
    ).toBe(0);
    expect(listWorkerRoles.mock.calls).toEqual([
      [workspace, 1, undefined],
      [workspace, 1, "a"],
    ]);
  });
  it("sends role-aware work without a separate resume", async () => {
    const sendMessage = vi.fn(async () => ({ value: { messageId: key } }));
    const resumeTask = vi.fn();
    const { runtime } = setup({ sendMessage, resumeTask });
    expect(
      await runProgram(runtime, [
        "task",
        "send",
        task,
        "--message",
        "Review exact revision",
        "--role",
        "reviewer",
        "--idempotency-key",
        key,
      ]),
    ).toBe(0);
    expect(sendMessage).toHaveBeenCalledWith(
      task,
      { message: "Review exact revision", roleKey: "reviewer" },
      key,
    );
    expect(resumeTask).not.toHaveBeenCalled();
  });
  it("saves auto-wake off without operating compute", async () => {
    const setTaskAutoWake = vi.fn(async () => ({
      value: { taskId: task, autoWakeOnResume: false },
    }));
    const { runtime } = setup({ setTaskAutoWake });
    expect(
      await runProgram(runtime, [
        "task",
        "auto-wake",
        task,
        "off",
        "--idempotency-key",
        key,
      ]),
    ).toBe(0);
    expect(setTaskAutoWake).toHaveBeenCalledWith(task, false, key);
  });
});
