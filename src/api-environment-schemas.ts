import { z } from "zod";

const generation = z.number().int().positive().safe();
const nonnegativeGeneration = z.number().int().nonnegative().safe();
const argumentsSchema = z.array(z.string().max(8192)).max(64);
export const sidecarReadinessRequestSchema = z
  .strictObject({
    kind: z.enum(["tcp", "http", "command"]),
    port: z.number().int().min(1).max(65535).nullable().optional(),
    path: z.string().max(2048).nullable().optional(),
    command: argumentsSchema.nullable().optional(),
    timeoutSeconds: z.number().int().min(1).max(300).optional(),
  })
  .superRefine((probe, context) => {
    if ((probe.kind === "tcp" || probe.kind === "http") && !probe.port)
      context.addIssue({
        code: "custom",
        message: "TCP and HTTP readiness require a port.",
      });
    if (probe.kind === "http" && !probe.path?.startsWith("/"))
      context.addIssue({
        code: "custom",
        message: "HTTP readiness requires an absolute path.",
      });
    if (probe.kind === "command" && !probe.command?.length)
      context.addIssue({
        code: "custom",
        message: "Command readiness requires a command.",
      });
  });
export const sidecarDefinitionRequestSchema = z.strictObject({
  id: z.guid().nullable(),
  label: z
    .string()
    .regex(/^[a-z](?:[a-z0-9-]{0,61}[a-z0-9])?$/)
    .refine(
      (value) =>
        !value.startsWith("vm-") && !["ns", "hostmaster"].includes(value),
      "This sidecar label is reserved.",
    ),
  name: z
    .string()
    .min(1)
    .max(128)
    .refine((value) => Boolean(value.trim())),
  templateId: z
    .string()
    .min(1)
    .max(128)
    .refine((value) => Boolean(value.trim())),
  templateRevision: generation,
  imageDigest: z.string().regex(/^sha256:[0-9a-f]{64}$/),
  architecture: z.enum(["x86_64", "aarch64"]),
  cpuCores: z.number().int().min(1).max(32),
  memoryMiB: z
    .number()
    .int()
    .min(128)
    .max(131072)
    .refine((value) => value % 1024 === 0),
  rootDiskGiB: z.number().int().min(1).max(2048),
  command: argumentsSchema,
  initializeCommand: argumentsSchema.nullable(),
  readiness: sidecarReadinessRequestSchema,
  secretReferences: z
    .record(
      z.string().regex(/^[A-Za-z_][A-Za-z0-9_]{0,127}$/),
      z.guid().refine((id) => id !== "00000000-0000-0000-0000-000000000000"),
    )
    .nullable()
    .optional(),
});
export const environmentDefinitionRequestSchema = z
  .strictObject({
    name: z
      .string()
      .min(1)
      .max(128)
      .refine((value) => Boolean(value.trim())),
    description: z.string().max(2048).nullable(),
    sidecars: z.array(sidecarDefinitionRequestSchema).max(16),
    authorizeService: z.boolean().optional(),
    idleGraceMinutes: z.number().int().min(1).max(1440).optional(),
  })
  .superRefine((definition, context) => {
    const ids = definition.sidecars.flatMap((sidecar) =>
      sidecar.id ? [sidecar.id] : [],
    );
    if (
      new Set(ids).size !== ids.length ||
      new Set(definition.sidecars.map((sidecar) => sidecar.label)).size !==
        definition.sidecars.length
    )
      context.addIssue({
        code: "custom",
        message: "Sidecar labels and identities must be unique.",
      });
  });
const sidecarViewSchema = z.looseObject({
  id: z.guid(),
  label: z.string(),
  name: z.string(),
  templateId: z.string(),
  templateRevision: generation,
  imageDigest: z.string(),
  architecture: z.string(),
  cpuCores: z.number().int().min(1).max(32),
  memoryMiB: z
    .number()
    .int()
    .min(128)
    .max(131072)
    .refine((value) => value % 1024 === 0),
  rootDiskGiB: z.number().int().min(1).max(2048),
  command: argumentsSchema,
  initializeCommand: argumentsSchema.nullable(),
  readiness: sidecarReadinessRequestSchema,
  secretReferences: z.record(z.string(), z.guid()),
  status: z.string(),
  failureCode: z.string().nullable(),
  qualifiedHost: z.string().nullable(),
  lastCommittedCaptureAt: z.string().nullable(),
  committedGeneration: nonnegativeGeneration,
  publicationStatus: z.string(),
  isAllocated: z.boolean(),
});
export const environmentUsageSchema = z.looseObject({
  attachedTaskCount: nonnegativeGeneration,
  demandConsumerCount: nonnegativeGeneration,
  allocatedSidecarCount: nonnegativeGeneration,
  configuredCpuCores: nonnegativeGeneration,
  configuredMemoryMiB: nonnegativeGeneration,
  durableStorageBytes: nonnegativeGeneration.nullable(),
});
export const environmentViewSchema = z.looseObject({
  id: z.guid(),
  workspaceId: z.guid(),
  name: z.string(),
  description: z.string().nullable(),
  generation,
  desiredPower: z.string(),
  status: z.string(),
  failureCode: z.string().nullable(),
  serviceAuthorized: z.boolean(),
  networkId: z.guid().nullable(),
  idleGraceMinutes: z.number().int().nonnegative(),
  sidecars: z.array(sidecarViewSchema),
  allowedActions: z.array(z.string()),
  usage: environmentUsageSchema.nullable().optional(),
});
export const environmentOperationSchema = z.looseObject({
  id: z.guid(),
  environmentId: z.guid(),
  action: z.string(),
  generation,
  status: z.string(),
  failureCode: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
  sidecarId: z.guid().nullable().optional(),
});
export const taskEnvironmentAttachmentSchema = z.looseObject({
  id: z.guid(),
  taskId: z.guid(),
  environmentId: z.guid(),
  environmentName: z.string(),
  generation,
  desiredMembership: z.enum(["attached", "detached"]),
  membershipStatus: z.string(),
  connectivity: z.enum(["inactive", "applying", "active", "error"]),
  connectivityReason: z.string().nullable(),
  dependencyStatus: z.string(),
  isDefaultDns: z.boolean(),
  endpoints: z.record(z.string(), z.string()),
  connectionBindings: z.record(z.string(), z.string()),
});
export const taskEnvironmentAttachmentsSchema = z.looseObject({
  generation,
  attachments: z.array(taskEnvironmentAttachmentSchema),
  defaultDnsAttachmentId: z.guid().nullable(),
});
export type EnvironmentDefinitionRequest = z.infer<
  typeof environmentDefinitionRequestSchema
>;

export const sidecarDiagnosticsSchema = z.looseObject({
  environmentId: z.guid(),
  sidecarId: z.guid(),
  status: z.string(),
  failureCode: z.string().nullable(),
  diagnostics: z
    .looseObject({
      logTail: z.string().max(8192),
      logTruncated: z.boolean(),
      probeKind: z.string().nullable(),
      probeState: z.enum(["pending", "succeeded", "failed", "timed_out"]),
      probeFailureCode: z.string().nullable(),
      probeObservedAt: z.string().nullable(),
      probeDurationMilliseconds: z
        .number()
        .int()
        .nonnegative()
        .safe()
        .nullable(),
    })
    .nullable(),
});
