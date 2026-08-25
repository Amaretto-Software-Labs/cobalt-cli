import type readline from "node:readline/promises";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CliError, ExitCode } from "./errors.js";
import {
  InteractiveForegroundOperation,
  InteractiveMutationCoordinator,
  interactiveWorkspaceLabel,
  isInteractiveAbort,
  isInteractiveCommandAllowedWhilePending,
  mergeInteractiveEventSequence,
  parseInteractiveLine,
  requireNextCursor,
  sanitizeInteractiveText,
  selectPaged,
} from "./interactive.js";

afterEach(() => vi.restoreAllMocks());

describe("interactive input parsing", () => {
  it("removes ANSI, OSC, and embedded control characters", () => {
    const value =
      "safe\u001b[31mred\u001b[0m\u001b]8;;https://evil.example\u0007link\u0000\nnext";

    const sanitized = sanitizeInteractiveText(value);

    expect(terminalControls(sanitized)).toEqual([]);
    expect(sanitized).not.toContain("\u001b");
    expect(sanitized).not.toContain("\u0007");
    expect(sanitized).toContain(
      "safe�[31mred�[0m�]8;;https://evil.example�link�",
    );
    expect(sanitized.endsWith("�next")).toBe(true);
  });

  it("shows the effective workspace instead of a stale saved workspace", () => {
    expect(
      interactiveWorkspaceLabel(
        {
          workspaceId: "22222222-2222-4222-8222-222222222222",
          workspaceName: "Override B",
        },
        "none",
      ),
    ).toBe("Override B");
  });

  it("preserves shell syntax as literal task input", () => {
    expect(parseInteractiveLine('/send "$(touch /tmp/never)"')).toEqual([
      "/send",
      "$(touch /tmp/never)",
    ]);
    expect(parseInteractiveLine("/send `whoami` $HOME *.secret")).toEqual([
      "/send",
      "`whoami`",
      "$HOME",
      "*.secret",
    ]);
  });

  it("does not fabricate missing tokens", () => {
    expect(parseInteractiveLine("/workspace")).toEqual(["/workspace"]);
    expect(parseInteractiveLine("   ")).toEqual([]);
  });
});

describe("interactive foreground cancellation", () => {
  it("recognizes mapped OAuth interruption as renewable foreground cancellation", () => {
    expect(
      isInteractiveAbort(new CliError("interrupted", ExitCode.interrupted)),
    ).toBe(true);
    expect(
      isInteractiveAbort(new CliError("unavailable", ExitCode.unavailable)),
    ).toBe(false);
  });

  it("cancels only the current operation and renews for the next prompt", () => {
    const session = new AbortController();
    const operation = new InteractiveForegroundOperation(session.signal);
    const first = operation.signal;

    operation.cancel();
    expect(first.aborted).toBe(true);
    expect(operation.sessionCancellationRequested).toBe(false);

    const second = operation.renew();
    expect(second.aborted).toBe(false);
    session.abort();
    expect(second.aborted).toBe(true);
    expect(operation.sessionCancellationRequested).toBe(true);
    operation.dispose();

    const replacement = new InteractiveForegroundOperation();
    const stale = replacement.signal;
    const current = replacement.renew();
    expect(stale.aborted).toBe(true);
    expect(current.aborted).toBe(false);
    replacement.dispose();
  });
});

describe("interactive mutation replay", () => {
  it("replays an ambiguous mutation with its original idempotency key", async () => {
    const key = "11111111-1111-4111-8111-111111111111";
    const coordinator = new InteractiveMutationCoordinator(() => key);
    const action = vi
      .fn<(key: string, signal: AbortSignal) => Promise<string>>()
      .mockRejectedValueOnce(
        new CliError("lost response", ExitCode.unavailable),
      )
      .mockResolvedValueOnce("replayed");
    const accepted = vi.fn(async () => undefined);
    const signal = new AbortController().signal;

    await expect(
      coordinator.execute("send message", action, accepted, signal),
    ).rejects.toThrow(
      `/retry to replay send message with idempotency key ${key}`,
    );
    await expect(coordinator.retry(signal)).resolves.toEqual({
      key,
      label: "send message",
    });

    expect(action).toHaveBeenCalledTimes(2);
    expect(action.mock.calls.map(([usedKey]) => usedKey)).toEqual([key, key]);
    expect(accepted).toHaveBeenCalledOnce();
    await expect(coordinator.retry(signal)).rejects.toMatchObject({
      exitCode: ExitCode.usage,
    });
  });

  it("does not retain a definitively rejected mutation", async () => {
    const coordinator = new InteractiveMutationCoordinator();
    const signal = new AbortController().signal;

    await expect(
      coordinator.execute(
        "cancel turn",
        async () => {
          throw new CliError("conflict", ExitCode.conflict);
        },
        async () => undefined,
        signal,
      ),
    ).rejects.toMatchObject({ exitCode: ExitCode.conflict });
    await expect(coordinator.retry(signal)).rejects.toMatchObject({
      exitCode: ExitCode.usage,
    });
  });

  it("does not make an accepted mutation replayable when a post-step fails", async () => {
    const coordinator = new InteractiveMutationCoordinator();
    const signal = new AbortController().signal;
    let acceptanceSurfaced = false;

    await expect(
      coordinator.execute(
        "create task",
        async () => ({ taskId: "task" }),
        async () => {
          acceptanceSurfaced = true;
          throw new CliError("post-step not found", ExitCode.notFound);
        },
        signal,
      ),
    ).rejects.toMatchObject({ exitCode: ExitCode.notFound });

    expect(acceptanceSurfaced).toBe(true);
    expect(coordinator.hasPending).toBe(false);
    await expect(coordinator.retry(signal)).rejects.toMatchObject({
      exitCode: ExitCode.usage,
    });
  });

  it("allows observation but blocks mutations and context changes while pending", () => {
    for (const command of [
      "/status",
      "/show",
      "/messages",
      "/events",
      "/wait",
      "/follow",
      "/repos",
      "/agents",
    ])
      expect(isInteractiveCommandAllowedWhilePending(command)).toBe(true);
    for (const command of [
      "/send",
      "/compose",
      "/new",
      "/cancel",
      "/workspace",
      "/tasks",
      "/enter",
      "/environment",
      "/logout",
    ])
      expect(isInteractiveCommandAllowedWhilePending(command)).toBe(false);
  });

  it("does not move the event cursor backward after observing then replaying", () => {
    expect(mergeInteractiveEventSequence(12, 4)).toBe(12);
    expect(mergeInteractiveEventSequence(12, 15)).toBe(15);
    expect(mergeInteractiveEventSequence(12, undefined)).toBe(12);
  });
});

describe("interactive paging", () => {
  it("sanitizes dynamic item text and prompts before writing to the terminal", async () => {
    const writes: string[] = [];
    vi.spyOn(process.stdout, "write").mockImplementation((value) => {
      writes.push(String(value));
      return true;
    });
    const prompts: string[] = [];
    const terminal = {
      question: vi.fn(async (prompt: string) => {
        prompts.push(prompt);
        return "cancel";
      }),
    } as unknown as readline.Interface;
    const malicious = "name\u001b[31m\u001b]0;owned\u0007\u0000";

    await selectPaged(
      async () => ({
        items: [{ id: "item", name: malicious }],
        hasMore: false,
      }),
      (item) => item.name,
      (item) => item.id,
      terminal,
      new AbortController().signal,
      `item\u001b]0;prompt\u0007`,
    );

    expect(terminalControls(writes.join(""), true)).toEqual([]);
    expect(terminalControls(prompts.join(""))).toEqual([]);
    expect(writes.join("")).toContain("name�[31m�]0;owned��");
  });

  it("rejects missing and active cursor cycles but permits next after back", () => {
    expect(() => requireNextCursor(null, [undefined])).toThrow();
    expect(() =>
      requireNextCursor("cursor-1", [undefined, "cursor-1"]),
    ).toThrow();
    expect(requireNextCursor("cursor-1", [undefined])).toBe("cursor-1");
  });

  it("allows numbered selection after navigating next, back, then next", async () => {
    vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    const answers = ["next", "back", "next", "1"];
    const terminal = {
      question: vi.fn(async () => answers.shift()!),
    } as unknown as readline.Interface;
    const loads: (string | undefined)[] = [];
    const selected = await selectPaged(
      async (cursor) => {
        loads.push(cursor);
        return cursor
          ? { items: [{ id: "second" }], hasMore: false }
          : {
              items: [{ id: "first" }],
              hasMore: true,
              nextCursor: "cursor-1",
            };
      },
      (item) => item.id,
      (item) => item.id,
      terminal,
      new AbortController().signal,
      "item",
    );
    expect(loads).toEqual([undefined, "cursor-1", undefined, "cursor-1"]);
    expect(selected).toEqual({ id: "second" });
  });
});

function terminalControls(value: string, allowLineFeed = false): number[] {
  return [...value]
    .map((character) => character.codePointAt(0)!)
    .filter(
      (codePoint) =>
        (codePoint < 32 || codePoint === 127) &&
        (!allowLineFeed || codePoint !== 10),
    );
}
