import { describe, expect, it, vi } from "vitest";
import type { CobaltApiClient, TaskEvent } from "./api.js";
import { readAvailableEvents } from "./events.js";

const event = (sequence: number): TaskEvent => ({
  sequence,
  eventType: "message",
  createdAt: "2026-08-25T12:00:00Z",
});

describe("readAvailableEvents", () => {
  it("sorts and suppresses duplicate or already-seen events", async () => {
    const api = {
      listEvents: vi.fn(async () => ({
        items: [event(3), event(2), event(2), event(1)],
        hasMore: false,
      })),
    } as unknown as CobaltApiClient;
    const emitted: number[] = [];
    await expect(
      readAvailableEvents(api, "task", 1, (item) =>
        emitted.push(item.sequence),
      ),
    ).resolves.toBe(3);
    expect(emitted).toEqual([2, 3]);
  });

  it("refetches a transient sequence gap before emitting", async () => {
    const api = {
      listEvents: vi
        .fn()
        .mockResolvedValueOnce({ items: [event(3)], hasMore: false })
        .mockResolvedValueOnce({ items: [event(2), event(3)], hasMore: false }),
    } as unknown as CobaltApiClient;
    const emitted: number[] = [];
    const delay = vi.fn(async () => undefined);
    await readAvailableEvents(
      api,
      "task",
      1,
      (item) => emitted.push(item.sequence),
      delay,
    );
    expect(delay).toHaveBeenCalledWith(100);
    expect(emitted).toEqual([2, 3]);
  });

  it("advances through an authorization-filtered gap after three bounded reads", async () => {
    const api = {
      listEvents: vi.fn(async () => ({ items: [event(4)], hasMore: false })),
    } as unknown as CobaltApiClient;
    const emitted: number[] = [];
    const delay = vi.fn(async () => undefined);
    await expect(
      readAvailableEvents(
        api,
        "task",
        1,
        (item) => emitted.push(item.sequence),
        delay,
      ),
    ).resolves.toBe(4);
    expect(api.listEvents).toHaveBeenCalledTimes(3);
    expect(delay).toHaveBeenCalledTimes(2);
    expect(emitted).toEqual([4]);
  });

  it("fails closed when a page claims more data without advancing", async () => {
    const api = {
      listEvents: vi.fn(async () => ({ items: [], hasMore: true })),
    } as unknown as CobaltApiClient;
    await expect(
      readAvailableEvents(
        api,
        "task",
        1,
        () => undefined,
        async () => undefined,
      ),
    ).rejects.toMatchObject({ exitCode: 8 });
  });
});
