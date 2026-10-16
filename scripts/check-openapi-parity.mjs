#!/usr/bin/env node
/* global process, URL */
import { readFile } from "node:fs/promises";

const expected = new Map([
  [
    "GET /v1/workspaces/{workspaceId}/environment-image-sources",
    ["ListEnvironmentImageSources", "listEnvironmentImageSources"],
  ],
  [
    "POST /v1/workspaces/{workspaceId}/environment-image-sources",
    ["CreateEnvironmentImageSource", "createEnvironmentImageSource"],
  ],
  [
    "PUT /v1/environment-image-sources/{sourceId}",
    ["UpdateEnvironmentImageSource", "updateEnvironmentImageSource"],
  ],
  [
    "DELETE /v1/environment-image-sources/{sourceId}",
    ["DeleteEnvironmentImageSource", "deleteEnvironmentImageSource"],
  ],
  [
    "GET /v1/environment-image-sources/{sourceId}/repositories",
    ["ListEnvironmentImageRepositories", "listEnvironmentImageRepositories"],
  ],
  [
    "GET /v1/environment-image-sources/{sourceId}/tags",
    ["ListEnvironmentImageTags", "listEnvironmentImageTags"],
  ],
  [
    "POST /v1/environments/{environmentId}/sidecars/{sidecarId}/image/retry",
    ["RetrySidecarImage", "retrySidecarImage"],
  ],
  [
    "GET /v1/environments/{environmentId}/sidecars/{sidecarId}/diagnostics",
    ["GetSidecarDiagnostics", "sidecarDiagnostics"],
  ],
  [
    "GET /v1/workspaces/{workspaceId}/pr-gates",
    ["InspectPrGates", "inspectPrGates"],
  ],
  [
    "PUT /v1/workspaces/{workspaceId}/pr-gates",
    ["ConfigurePrGate", "configurePrGate"],
  ],
  [
    "POST /v1/workspaces/{workspaceId}/pr-gates/{registrationId}/actions",
    ["PrGateAction", "prGateAction"],
  ],
  [
    "GET /v1/workspaces/{workspaceId}/environments",
    ["ListEnvironments", "listEnvironments"],
  ],
  [
    "POST /v1/workspaces/{workspaceId}/environments",
    ["CreateEnvironment", "createEnvironment"],
  ],
  [
    "GET /v1/environments/{environmentId}",
    ["GetEnvironment", "getEnvironment"],
  ],
  [
    "PUT /v1/environments/{environmentId}",
    ["UpdateEnvironment", "updateEnvironment"],
  ],
  [
    "GET /v1/environment-operations/{operationId}",
    ["GetEnvironmentOperation", "getEnvironmentOperation"],
  ],
  [
    "POST /v1/environments/{environmentId}/actions/{action}",
    ["EnvironmentAction", "environmentAction"],
  ],
  [
    "POST /v1/environments/{environmentId}/sidecars/{sidecarId}/actions/{action}",
    ["SidecarAction", "sidecarAction"],
  ],
  [
    "GET /v1/tasks/{taskId}/environment-attachments",
    ["ListTaskEnvironmentAttachments", "listTaskEnvironmentAttachments"],
  ],
  [
    "POST /v1/tasks/{taskId}/environment-attachments",
    ["AttachTaskEnvironment", "attachTaskEnvironment"],
  ],
  [
    "DELETE /v1/tasks/{taskId}/environment-attachments/{attachmentId}",
    ["DetachTaskEnvironment", "detachTaskEnvironment"],
  ],
  [
    "PUT /v1/tasks/{taskId}/environment-dns-default",
    ["SetTaskEnvironmentDnsDefault", "setTaskEnvironmentDnsDefault"],
  ],
  [
    "GET /v1/workspaces/{workspaceId}/task-queue",
    ["ListTaskQueue", "listTaskQueue"],
  ],
  [
    "POST /v1/tasks/{taskId}/admission/{action}",
    ["MutateTaskAdmission", "mutateTaskAdmission"],
  ],
  ["GET /v1/workspaces/{workspaceId}/loops", ["ListLoops", "listLoops"]],
  ["POST /v1/workspaces/{workspaceId}/loops", ["CreateLoop", "createLoop"]],
  ["GET /v1/workspaces/{workspaceId}/loops/{loopId}", ["GetLoop", "getLoop"]],
  [
    "PUT /v1/workspaces/{workspaceId}/loops/{loopId}/definition",
    ["UpdateLoop", "updateLoop"],
  ],
  [
    "POST /v1/workspaces/{workspaceId}/loops/{loopId}/enable",
    ["EnableLoop", "enableLoop"],
  ],
  [
    "POST /v1/workspaces/{workspaceId}/loops/{loopId}/disable",
    ["DisableLoop", "disableLoop"],
  ],
  [
    "DELETE /v1/workspaces/{workspaceId}/loops/{loopId}",
    ["DeleteLoop", "deleteLoop"],
  ],
  [
    "POST /v1/workspaces/{workspaceId}/loops/{loopId}/run",
    ["RunLoop", "runLoop"],
  ],
  [
    "POST /v1/workspaces/{workspaceId}/loops/{loopId}/runs/{runId}/rerun",
    ["RerunLoop", "rerunLoop"],
  ],
  [
    "GET /v1/workspaces/{workspaceId}/loops/{loopId}/runs",
    ["ListLoopRuns", "listLoopRuns"],
  ],
  [
    "GET /v1/workspaces/{workspaceId}/loops/{loopId}/decisions",
    ["ListLoopDecisions", "listLoopDecisions"],
  ],
  [
    "GET /v1/workspaces/{workspaceId}/loops/{loopId}/lanes",
    ["ListLoopLanes", "listLoopLanes"],
  ],
  [
    "GET /v1/workspaces/{workspaceId}/loop-event-descriptors",
    ["ListLoopEventDescriptors", "listLoopEventDescriptors"],
  ],
  [
    "POST /v1/workspaces/{workspaceId}/loop-schedule-preview",
    ["PreviewLoopSchedule", "previewLoopSchedule"],
  ],
  [
    "GET /v1/workspaces/{workspaceId}/worker-roles",
    ["ListWorkerRoles", "listWorkerRoles"],
  ],
  [
    "GET /v1/workspaces/{workspaceId}/worker-roles/{roleKey}",
    ["GetWorkerRole", "getWorkerRole"],
  ],
  [
    "POST /v1/workspaces/{workspaceId}/worker-roles",
    ["CreateWorkerRole", "createWorkerRole"],
  ],
  [
    "PUT /v1/workspaces/{workspaceId}/worker-roles/{roleKey}",
    ["UpdateWorkerRole", "updateWorkerRole"],
  ],
  [
    "DELETE /v1/workspaces/{workspaceId}/worker-roles/{roleKey}",
    ["DeleteWorkerRole", "deleteWorkerRole"],
  ],
  ["PUT /v1/tasks/{taskId}/auto-wake", ["SetTaskAutoWake", "setTaskAutoWake"]],

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
  ["DELETE /v1/tasks/{taskId}", ["DeleteTask", "deleteTask"]],
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
// These OAuth browser-scope operations belong to the browser extension, not the CLI.
const browserOperations = new Map([
  ["PUT /v1/browser-client-sessions/{sessionId}", "ConnectBrowserSession"],
  [
    "DELETE /v1/browser-client-sessions/{sessionId}",
    "DisconnectBrowserSession",
  ],
  [
    "POST /v1/browser-client-sessions/{sessionId}/heartbeat",
    "HeartbeatBrowserSession",
  ],
  [
    "GET /v1/browser-client-sessions/{sessionId}/tool-calls",
    "ListBrowserToolCalls",
  ],
  ["POST /v1/browser-tool-calls/{callId}/complete", "CompleteBrowserToolCall"],
]);
const mismatches = [];
const schemas = document.components?.schemas ?? {};
for (const [name, properties] of [
  ["CreateTaskRequest", ["environmentIds", "defaultDnsEnvironmentId"]],
  [
    "EnvironmentDefinitionRequest",
    ["name", "description", "sidecars", "authorizeService"],
  ],
  [
    "SidecarDefinitionRequest",
    ["image", "secretReferences", "command", "initializeCommand", "readiness"],
  ],
  ["SidecarImageRequest", ["kind", "reference", "sourceId"]],
  [
    "EnvironmentImageSourceRequest",
    ["name", "registryHost", "username", "credentialEntryId"],
  ],
  ["EnvironmentImageSourceView", ["id", "workspaceId", "generation"]],
  ["SidecarView", ["image", "imageStatus", "imageFailureCode"]],
  [
    "TaskEnvironmentAttachmentView",
    ["desiredMembership", "connectivity", "connectionBindings"],
  ],
]) {
  for (const property of properties)
    if (!schemas[name]?.properties?.[property])
      mismatches.push(`${name}.${property}: missing public environment field`);
}
for (const name of [
  "UpdateEnvironmentRequest",
  "EnvironmentActionRequest",
  "SetEnvironmentDnsDefaultRequest",
  "UpdateEnvironmentImageSourceRequest",
])
  if (
    !schemas[name]?.required?.includes("expectedGeneration") ||
    schemas[name]?.properties?.expectedGeneration?.format !== "int64"
  )
    mismatches.push(`${name}: missing required int64 generation fence`);
if (
  schemas.CreateTaskRequest?.properties?.environmentIds?.items?.format !==
  "uuid"
)
  mismatches.push(
    "CreateTaskRequest.environmentIds: expected UUID membership set",
  );
if (
  !schemas.SetEnvironmentDnsDefaultRequest?.required?.includes(
    "attachmentId",
  ) ||
  !schemas.SetEnvironmentDnsDefaultRequest?.properties?.attachmentId?.type?.includes(
    "null",
  )
)
  mismatches.push(
    "SetEnvironmentDnsDefaultRequest: DNS selection must be explicitly nullable",
  );
if (
  schemas.SidecarDefinitionRequest?.properties?.environment ||
  schemas.EnvironmentDefinitionRequest?.properties?.environment
)
  mismatches.push(
    "Environment definitions must expose secretReferences rather than plaintext launch environment values",
  );
for (const property of [
  "templateId",
  "templateRevision",
  "imageDigest",
  "architecture",
])
  if (schemas.SidecarDefinitionRequest?.properties?.[property])
    mismatches.push(
      `SidecarDefinitionRequest.${property}: internal image mechanic must not be a public input`,
    );
if (schemas.EnvironmentImageSourceRequest?.properties?.secret)
  mismatches.push(
    "Registry sources must reference existing Vault secrets rather than accept secret values",
  );
for (const [route, operation] of browserOperations) {
  if (actual.get(route) !== operation)
    mismatches.push(`${route}: browser contract changed`);
}

for (const [route, [operation, method]] of expected) {
  if (actual.get(route) !== operation)
    mismatches.push(
      `${route}: expected ${operation}, found ${String(actual.get(route))}`,
    );
  if (!new RegExp(`public\\s+${method}\\s*\\(`).test(clientSource))
    mismatches.push(`${route}: missing CobaltApiClient.${method} mapping`);
}
for (const route of actual.keys())
  if (!expected.has(route) && !browserOperations.has(route))
    mismatches.push(`${route}: missing CLI operation mapping`);
if (
  mismatches.length ||
  actual.size !== expected.size + browserOperations.size
) {
  process.stderr.write(
    `Cobalt External API parity check failed:\n${mismatches.map((item) => `- ${item}`).join("\n")}\n`,
  );
  process.exit(1);
}
process.stdout.write(
  `Cobalt External API parity: ${expected.size} CLI operations mapped; ${browserOperations.size} browser-extension operations accounted for.\n`,
);
