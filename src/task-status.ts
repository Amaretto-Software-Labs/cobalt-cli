const terminalTaskStatuses = new Set([
  "ready",
  "suspended",
  "recovery_required",
  "deletion_failed",
  "error",
  "expiration_cleanup_required",
  "expired",
  "deleted",
]);

export function isTerminalTaskStatus(status: string): boolean {
  return terminalTaskStatuses.has(status);
}
