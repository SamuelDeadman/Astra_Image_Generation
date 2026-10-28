import { z } from "zod";

export const workerTaskContractName = "astraflow.generation.worker-task";
export const workerUpdateContractName = "astraflow.generation.worker-update";
export const workerContractVersion = 1;

const identifierSchema = z.string().min(1).max(140).regex(/^[a-zA-Z0-9_-]+$/);
const safeMessageSchema = z.string().min(1).max(300);
const stableErrorCodeSchema = z.string().min(2).max(80).regex(/^[A-Z0-9_]+$/);

export const workerTaskPayloadSchema = z
  .object({
    contract: z.literal(workerTaskContractName),
    version: z.literal(workerContractVersion),
    jobId: identifierSchema,
    workflowRevisionId: identifierSchema,
    attemptId: identifierSchema
  })
  .strict();

export const generatedOutputArtifactSchema = z
  .object({
    contentType: z.enum(["image/png", "image/jpeg", "image/webp"]),
    width: z.number().int().min(1).max(8192),
    height: z.number().int().min(1).max(8192),
    sizeBytes: z.number().int().min(1).max(100 * 1024 * 1024),
    sha256: z.string().regex(/^[a-f0-9]{64}$/),
    storage: z
      .object({
        bucket: z.string().min(1).max(222),
        objectPath: z.string().min(1).max(1024)
      })
      .strict(),
    developmentOnly: z.boolean().optional()
  })
  .strict();

export const workerProgressUpdateSchema = z
  .object({
    type: z.literal("progress"),
    status: z.enum(["VALIDATING", "STARTING", "LOADING_MODEL", "GENERATING", "POST_PROCESSING", "UPLOADING"]),
    progress: z.number().int().min(1).max(99),
    message: safeMessageSchema.optional()
  })
  .strict();

export const workerCompletedUpdateSchema = z
  .object({
    type: z.literal("completed"),
    progress: z.literal(100),
    actualCredits: z.number().int().min(0).max(100000),
    output: generatedOutputArtifactSchema
  })
  .strict();

export const workerFailedUpdateSchema = z
  .object({
    type: z.literal("failed"),
    errorCode: stableErrorCodeSchema,
    errorMessage: safeMessageSchema,
    retryable: z.boolean().default(false)
  })
  .strict();

export const workerCancelledUpdateSchema = z
  .object({
    type: z.literal("cancelled"),
    reason: safeMessageSchema.default("Generation was cancelled.")
  })
  .strict();

export const workerUpdatePayloadSchema = z
  .object({
    contract: z.literal(workerUpdateContractName),
    version: z.literal(workerContractVersion),
    jobId: identifierSchema,
    attemptId: identifierSchema,
    update: z.discriminatedUnion("type", [
      workerProgressUpdateSchema,
      workerCompletedUpdateSchema,
      workerFailedUpdateSchema,
      workerCancelledUpdateSchema
    ])
  })
  .strict();

export type WorkerTaskPayload = z.infer<typeof workerTaskPayloadSchema>;
export type GeneratedOutputArtifact = z.infer<typeof generatedOutputArtifactSchema>;
export type WorkerUpdatePayload = z.infer<typeof workerUpdatePayloadSchema>;
export type WorkerProgressUpdate = z.infer<typeof workerProgressUpdateSchema>;
export type WorkerCompletedUpdate = z.infer<typeof workerCompletedUpdateSchema>;
export type WorkerFailedUpdate = z.infer<typeof workerFailedUpdateSchema>;
export type WorkerCancelledUpdate = z.infer<typeof workerCancelledUpdateSchema>;

export function createWorkerTaskPayload(input: {
  jobId: string;
  workflowRevisionId: string;
  attemptId: string;
}): WorkerTaskPayload {
  return workerTaskPayloadSchema.parse({
    contract: workerTaskContractName,
    version: workerContractVersion,
    jobId: input.jobId,
    workflowRevisionId: input.workflowRevisionId,
    attemptId: input.attemptId
  });
}

