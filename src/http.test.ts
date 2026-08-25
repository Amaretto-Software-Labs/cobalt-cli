import { describe, expect, it } from "vitest";
import { readBoundedBytes } from "./http.js";

describe("bounded response reads", () => {
  it("combines a response stream within the byte limit", async () => {
    const response = new Response(
      new ReadableStream({
        start(controller) {
          controller.enqueue(new Uint8Array([1, 2]));
          controller.enqueue(new Uint8Array([3]));
          controller.close();
        },
      }),
    );
    await expect(readBoundedBytes(response, 3)).resolves.toEqual(
      new Uint8Array([1, 2, 3]),
    );
  });

  it("cancels an oversized response without buffering the remaining stream", async () => {
    let pulls = 0;
    let cancelled = false;
    const response = new Response(
      new ReadableStream({
        pull(controller) {
          pulls++;
          controller.enqueue(new Uint8Array(4));
        },
        cancel() {
          cancelled = true;
        },
      }),
    );
    await expect(readBoundedBytes(response, 5)).rejects.toBeInstanceOf(
      RangeError,
    );
    expect(cancelled).toBe(true);
    expect(pulls).toBeLessThanOrEqual(2);
  });
});
