import { z } from "zod";
export const loopSchema = z.looseObject({
  id: z.guid(),
  name: z.string(),
  status: z.string(),
  definitionVersion: z.number().int().positive(),
});
export const loopDetailSchema = loopSchema.extend({
  document: z.string(),
  workspaceId: z.guid(),
});
export const loopMutationSchema = z.looseObject({ loop: loopDetailSchema });
export const loopRunSchema = z.looseObject({
  id: z.guid(),
  loopId: z.guid(),
  status: z.string(),
  definitionVersion: z.number().int(),
});
export const loopRunMutationSchema = z.looseObject({ run: loopRunSchema });
export const loopDecisionSchema = z.looseObject({
  id: z.guid(),
  outcome: z.string(),
  eventType: z.string(),
});
export const loopLaneSchema = z.looseObject({
  id: z.guid(),
  status: z.string(),
  subjectKind: z.string(),
  subjectExternalId: z.string(),
});
export const roleSchema = z.looseObject({
  key: z.string(),
  name: z.string(),
  description: z.string(),
  revision: z.number().int().positive(),
  hash: z.string(),
});
export const roleDetailSchema = roleSchema.extend({ instructions: z.string() });
