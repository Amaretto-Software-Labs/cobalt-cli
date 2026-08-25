#!/usr/bin/env node
/* global process, URL */
import { readFile } from "node:fs/promises";

const expected = new Map([
  ["GET /v1/workspaces", ["ListWorkspaces", "listWorkspaces"]],
  [
    "GET /v1/workspaces/{workspaceId}/repositories",
    ["ListRepositories", "listRepositories"],
  ],
  ["GET /v1/agent-accounts", ["ListAgentAccounts", "listAgents"]],
  ["GET /v1/workspaces/{workspaceId}/tasks", ["ListTasks", "listTasks"]],
  ["POST /v1/workspaces/{workspaceId}/tasks", ["CreateTask", "createTask"]],
  [
    "POST /v1/workspaces/{workspaceId}/tasks/search",
    ["SearchTasks", "searchTasks"],
  ],
  [
    "POST /v1/workspaces/{workspaceId}/task-messages/search",
    ["SearchTaskMessages", "searchMessages"],
  ],
  ["GET /v1/tasks/{taskId}", ["GetTask", "getTask"]],
  ["GET /v1/tasks/{taskId}/messages", ["ListTaskMessages", "listMessages"]],
  ["POST /v1/tasks/{taskId}/messages", ["SendTaskMessage", "sendMessage"]],
  ["GET /v1/tasks/{taskId}/events", ["ListTaskEvents", "listEvents"]],
  [
    "POST /v1/tasks/{taskId}/messages/{messageId}/steer",
    ["SteerTaskMessage", "steerMessage"],
  ],
  ["POST /v1/tasks/{taskId}/turn/cancel", ["CancelTaskTurn", "cancelTurn"]],
  ["POST /v1/tasks/{taskId}/suspend", ["SuspendTask", "suspendTask"]],
  ["POST /v1/tasks/{taskId}/resume", ["ResumeTask", "resumeTask"]],
  ["POST /v1/tasks/wait", ["WaitForTasks", "waitForTasks"]],
]);

const document = JSON.parse(
  await readFile(new URL("../openapi/v1.json", import.meta.url), "utf8"),
);
const clientSource = await readFile(
  new URL("../src/api.ts", import.meta.url),
  "utf8",
);
const actual = new Map();
for (const [path, methods] of Object.entries(document.paths ?? {})) {
  for (const [method, operation] of Object.entries(methods)) {
    if (["get", "post", "put", "patch", "delete"].includes(method))
      actual.set(`${method.toUpperCase()} ${path}`, operation.operationId);
  }
}
const mismatches = [];
for (const [route, [operation, method]] of expected) {
  if (actual.get(route) !== operation)
    mismatches.push(
      `${route}: expected ${operation}, found ${String(actual.get(route))}`,
    );
  if (!new RegExp(`public\\s+${method}\\s*\\(`).test(clientSource))
    mismatches.push(`${route}: missing CobaltApiClient.${method} mapping`);
}
for (const route of actual.keys())
  if (!expected.has(route))
    mismatches.push(`${route}: missing CLI operation mapping`);
if (mismatches.length || actual.size !== 16) {
  process.stderr.write(
    `Cobalt External API parity check failed:\n${mismatches.map((item) => `- ${item}`).join("\n")}\n`,
  );
  process.exit(1);
}
process.stdout.write("Cobalt External API parity: 16/16 operations mapped.\n");
