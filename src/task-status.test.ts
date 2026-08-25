import { describe, expect, it } from "vitest";
import { isTerminalTaskStatus } from "./task-status.js";

describe("terminal task statuses", () => {
  it.each([
    "ready",
    "suspended",
    "recovery_required",
    "deletion_failed",
    "error",
    "expiration_cleanup_required",
    "expired",
    "deleted",
  ])("treats %s as terminal for command and interactive follow", (status) => {
    expect(isTerminalTaskStatus(status)).toBe(true);
  });

  it.each([
    "provisioning",
    "running",
    "suspending",
    "resuming",
    "recovering",
    "unavailable",
    "snapshotting",
    "deleting",
    "expiring",
  ])("continues following %s", (status) => {
    expect(isTerminalTaskStatus(status)).toBe(false);
  });
});
