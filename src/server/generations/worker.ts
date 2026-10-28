import "server-only";

import { nanoid } from "nanoid";
import type { ClientSession, Collection } from "mongodb";
import { writeAuditEvent } from "@/server/audit/audit";
import { registerGeneratedOutput } from "@/server/assets/assets";
import { assertWorkflowAssetsOwned } from "@/server/assets/assets";
import { buildGeneratedOutputAssetId } from "@/server/assets/generated-output-contract";
import { captureGenerationCredits, refundGenerationCredits } from "@/server/credits/ledger";
import { mongoCollection, withMongoTransaction } from "@/server/db/mongodb";
import {
  collectionNames,
  type ExecutionPlanDocument,
  type GenerationJobDocument,
  type GenerationJobEventDocument,
  type GenerationStatus,
  type WorkflowRevisionDocument
} from "@/server/db/types";
import { AppError } from "@/server/errors";
import { requireEnabledModels } from "@/server/models/models";
import { withModelVerification } from "@/server/models/verification-context";
import { getWorkflowModelIds } from "@/lib/workflow/schema";
import {
  GenerationInferenceFailure,
  getStepExecutionAdapter,
  normalizeInferenceFailure,
  normalizeStepOutputs,
  type StepInputValue,
  type StepOutputValue
} from "@/server/generations/inference-adapters";
import {
  activeGenerationStatuses,
  canClaimAttempt,
  claimableAttemptStatuses,
  generationAuditReference,
  isLegalGenerationTransition,
  isTerminalGenerationStatus,
  terminalAttemptStatuses
} from "@/server/generations/lifecycle-rules";
import type { WorkerProgressUpdate, WorkerTaskPayload } from "@/server/generations/worker-contract";

const workerLeaseMs = 1000 * 60 * 30;
const claimableJobStatuses: GenerationStatus[] = ["QUEUED", "VALIDATING", "STARTING"];

export type GenerationWorkerRunResult = {
  outcome: "completed" | "failed" | "cancelled" | "duplicate" | "rejected" | "retry";
  jobId: string;
  attemptId: string;
  status?: GenerationStatus;
  errorCode?: string;
  retryable?: boolean;
};

type ClaimedAttempt =
  | {
      claimed: true;
      job: GenerationJobDocument;
    }
  | {
      claimed: false;
      result: GenerationWorkerRunResult;
    };

function workerLeaseExpiresAt() {
  return new Date(Date.now() + workerLeaseMs);
}

function event(input: {
  id?: string;
  status: GenerationStatus;
  progress: number;
  message: string;
  metadata?: Record<string, unknown>;
}): GenerationJobEventDocument {
  return {
    id: input.id ?? nanoid(),
    status: input.status,
    progress: input.progress,
    message: input.message,
    ...(input.metadata ? { metadata: input.metadata } : {}),
    createdAt: new Date()
  };
}

function terminalResult(input: {
  outcome: GenerationWorkerRunResult["outcome"];
  payload: WorkerTaskPayload;
  status?: GenerationStatus;
  errorCode?: string;
  retryable?: boolean;
}): GenerationWorkerRunResult {
  return {
    outcome: input.outcome,
    jobId: input.payload.jobId,
    attemptId: input.payload.attemptId,
    ...(input.status ? { status: input.status } : {}),
    ...(input.errorCode ? { errorCode: input.errorCode } : {}),
    ...(typeof input.retryable === "boolean" ? { retryable: input.retryable } : {})
  };
}

async function appendJobEventOnce(
  jobs: Collection<GenerationJobDocument>,
  jobId: string,
  jobEvent: GenerationJobEventDocument,
  session?: ClientSession
) {
  await jobs.updateOne(
    {
      _id: jobId,
      "events.id": { $ne: jobEvent.id }
    },
    {
      $push: {
        events: jobEvent
      }
    },
    { session }
  );
}

async function auditWorkerEventOnce(input: {
  job: Pick<GenerationJobDocument, "_id" | "ownerId" | "workflowRevisionId" | "modelId" | "reservedCredits">;
  attemptId: string;
  event: "dispatched" | "acknowledged" | "completed" | "failed" | "cancelled" | "rejected" | "retrying";
  metadata?: Record<string, unknown>;
}) {
  await writeAuditEvent({
    userId: input.job.ownerId,
    eventType: `generation.worker.${input.event}`,
    targetType: "generation_job",
    targetId: input.job._id,
    referenceId: generationAuditReference(input.job._id, input.attemptId, input.event),
    metadata: {
      attemptId: input.attemptId,
      workflowRevisionId: input.job.workflowRevisionId,
      modelId: input.job.modelId,
      ...(input.metadata ?? {})
    }
  });
}

async function auditRejectedAttempt(input: {
  payload: WorkerTaskPayload;
  reason: string;
  job?: Pick<GenerationJobDocument, "_id" | "ownerId" | "workflowRevisionId" | "modelId" | "reservedCredits">;
}) {
  if (!input.job) {
    return;
  }

  await auditWorkerEventOnce({
    job: input.job,
    attemptId: input.payload.attemptId,
    event: "rejected",
    metadata: {
      reason: input.reason
    }
  });
}

export async function recordGenerationDispatchAudit(input: {
  job: Pick<GenerationJobDocument, "_id" | "ownerId" | "workflowRevisionId" | "modelId" | "reservedCredits">;
  attemptId: string;
  taskName: string;
  dispatchMode: "cloud-tasks" | "local";
}) {
  await auditWorkerEventOnce({
    job: input.job,
    attemptId: input.attemptId,
    event: "dispatched",
    metadata: {
      dispatchMode: input.dispatchMode,
      taskName: input.taskName
    }
  });
}

async function claimGenerationAttempt(payload: WorkerTaskPayload): Promise<ClaimedAttempt> {
  const jobs = await mongoCollection<GenerationJobDocument>(collectionNames.generationJobs);
  const now = new Date();
  const leaseExpiresAt = workerLeaseExpiresAt();
  const job = await jobs.findOneAndUpdate(
    {
      _id: payload.jobId,
      workflowRevisionId: payload.workflowRevisionId,
      status: { $in: claimableJobStatuses },
      attempts: {
        $elemMatch: {
          id: payload.attemptId,
          $or: [
            { status: { $in: claimableAttemptStatuses } },
            { status: "ACKNOWLEDGED", leaseExpiresAt: { $lte: now } }
          ]
        }
      }
    },
    {
      $set: {
        status: "VALIDATING",
        startedAt: now,
        "attempts.$.status": "ACKNOWLEDGED",
        "attempts.$.acknowledgedAt": now,
        "attempts.$.leaseExpiresAt": leaseExpiresAt
      },
      $max: {
        progress: 5
      },
      $push: {
        events: event({
          status: "VALIDATING",
          progress: 5,
          message: "Worker acknowledged generation attempt.",
          metadata: {
            attemptId: payload.attemptId
          }
        })
      }
    },
    { returnDocument: "after" }
  );

  if (job) {
    await auditWorkerEventOnce({
      job,
      attemptId: payload.attemptId,
      event: "acknowledged"
    });
    return { claimed: true, job };
  }

  const existing = await jobs.findOne({ _id: payload.jobId });

  if (!existing) {
    return {
      claimed: false,
      result: terminalResult({
        outcome: "rejected",
        payload,
        errorCode: "GENERATION_JOB_NOT_FOUND"
      })
    };
  }

  const decision = canClaimAttempt({
    jobStatus: existing.status,
    jobWorkflowRevisionId: existing.workflowRevisionId,
    payloadWorkflowRevisionId: payload.workflowRevisionId,
    attempts: existing.attempts,
    attemptId: payload.attemptId,
    now
  });

  const reason = decision.ok ? "job_not_claimable" : decision.reason;
  await auditRejectedAttempt({ payload, reason, job: existing });

  return {
    claimed: false,
    result: terminalResult({
      outcome: isTerminalGenerationStatus(existing.status) ? "duplicate" : "rejected",
      payload,
      status: existing.status,
      errorCode: reason.toUpperCase()
    })
  };
}

async function isGenerationCancelled(payload: WorkerTaskPayload) {
  const jobs = await mongoCollection<GenerationJobDocument>(collectionNames.generationJobs);
  const job = await jobs.findOne(
    {
      _id: payload.jobId,
      status: "CANCELLED",
      "attempts.id": payload.attemptId
    },
    { projection: { _id: 1 } }
  );

  return Boolean(job);
}

async function recordWorkerProgress(payload: WorkerTaskPayload, update: WorkerProgressUpdate) {
  const jobs = await mongoCollection<GenerationJobDocument>(collectionNames.generationJobs);
  const job = await jobs.findOne({
    _id: payload.jobId,
    workflowRevisionId: payload.workflowRevisionId,
    "attempts.id": payload.attemptId
  });

  if (!job) {
    return terminalResult({
      outcome: "rejected",
      payload,
      errorCode: "GENERATION_JOB_NOT_FOUND"
    });
  }

  if (job.status === "CANCELLED") {
    return markGenerationAttemptCancelled(payload, "Generation was cancelled.");
  }

  if (isTerminalGenerationStatus(job.status)) {
    return terminalResult({
      outcome: "duplicate",
      payload,
      status: job.status
    });
  }

  if (!isLegalGenerationTransition(job.status, update.status)) {
    await auditRejectedAttempt({
      payload,
      reason: "illegal_status_transition",
      job
    });
    return terminalResult({
      outcome: "rejected",
      payload,
      status: job.status,
      errorCode: "ILLEGAL_STATUS_TRANSITION"
    });
  }

  const progress = Math.max(job.progress, update.progress);
  const result = await jobs.updateOne(
    {
      _id: payload.jobId,
      workflowRevisionId: payload.workflowRevisionId,
      status: job.status,
      attempts: {
        $elemMatch: {
          id: payload.attemptId,
          status: "ACKNOWLEDGED"
        }
      }
    },
    {
      $set: {
        status: update.status,
        progress,
        "attempts.$.leaseExpiresAt": workerLeaseExpiresAt()
      },
      $push: {
        events: event({
          status: update.status,
          progress,
          message: update.message ?? "Generation worker advanced.",
          metadata: {
            attemptId: payload.attemptId
          }
        })
      }
    }
  );

  if (result.modifiedCount === 1) {
    return null;
  }

  const latest = await jobs.findOne({ _id: payload.jobId });

  if (latest?.status === "CANCELLED") {
    return markGenerationAttemptCancelled(payload, "Generation was cancelled.");
  }

  await auditRejectedAttempt({
    payload,
    reason: "stale_progress_update",
    job: latest ?? job
  });

  return terminalResult({
    outcome: latest && isTerminalGenerationStatus(latest.status) ? "duplicate" : "rejected",
    payload,
    status: latest?.status,
    errorCode: "STALE_WORKER_PROGRESS"
  });
}

async function loadExecutionContext(
  payload: WorkerTaskPayload,
  claimedJob: GenerationJobDocument
): Promise<{
  job: GenerationJobDocument;
  workflowRevision: WorkflowRevisionDocument;
  executionPlan: ExecutionPlanDocument;
}> {
  const revisions = await mongoCollection<WorkflowRevisionDocument>(collectionNames.workflowRevisions);
  const plans = await mongoCollection<ExecutionPlanDocument>(collectionNames.executionPlans);
  const workflowRevision = await revisions.findOne({
    _id: payload.workflowRevisionId,
    ownerId: claimedJob.ownerId
  });

  if (!workflowRevision || workflowRevision.workflowId !== claimedJob.workflowId) {
    throw new AppError("NOT_FOUND", "The saved workflow revision for this generation was not found.", 404);
  }

  if (!claimedJob.executionPlanId || !claimedJob.executionPlanHash) {
    throw new AppError("CONFLICT", "The generation job is missing its immutable execution plan.", 409);
  }

  const executionPlan = await plans.findOne({
    _id: claimedJob.executionPlanId,
    ownerId: claimedJob.ownerId,
    workflowRevisionId: payload.workflowRevisionId,
    planHash: claimedJob.executionPlanHash
  });

  if (!executionPlan) {
    throw new AppError("CONFLICT", "The persisted execution plan for this generation was not found.", 409);
  }
  await requireEnabledModels(getWorkflowModelIds(workflowRevision.workflow));
  await assertWorkflowAssetsOwned(claimedJob.ownerId, workflowRevision.workflow);

  return {
    job: claimedJob,
    workflowRevision,
    executionPlan
  };
}

function normalizeWorkerFailure(error: unknown) {
  const adapterFailure = normalizeInferenceFailure(error);

  if (error instanceof AppError) {
    if (error.code === "CONFIGURATION_REQUIRED") return { errorCode: error.code, errorMessage: error.message.slice(0, 300), retryable: false };
    return {
      errorCode: error.code,
      errorMessage:
        error.status >= 500
          ? "The generation worker could not complete the request."
          : error.message,
      retryable: error.status >= 500
    };
  }

  return adapterFailure;
}

function stepLeaseExpiresAt() {
  return new Date(Date.now() + workerLeaseMs);
}

function completedStepOutputs(job: GenerationJobDocument) {
  const outputs = new Map<string, Record<string, StepOutputValue>>();

  for (const step of job.steps ?? []) {
    if (step.status === "COMPLETED" && step.outputs) {
      outputs.set(step.id, step.outputs as Record<string, StepOutputValue>);
    }
  }

  return outputs;
}

function constantInputValue(value: unknown, type: string): StepInputValue {
  if (type === "text") {
    return { type: "text", text: typeof value === "string" ? value : "" };
  }

  if (type === "dimensions" && value && typeof value === "object") {
    const dimensions = value as { width?: unknown; height?: unknown; batch?: unknown };
    return {
      type: "dimensions",
      width: typeof dimensions.width === "number" ? dimensions.width : 768,
      height: typeof dimensions.height === "number" ? dimensions.height : 768,
      batch: typeof dimensions.batch === "number" ? dimensions.batch : 1
    };
  }

  if (type === "seed" && value && typeof value === "object") {
    const seed = value as { seed?: unknown; locked?: unknown };
    return {
      type: "seed",
      seed: typeof seed.seed === "number" ? seed.seed : 0,
      locked: seed.locked === true
    };
  }

  if (type === "image" && value && typeof value === "object") {
    const image = value as {
      assetId?: unknown;
      bucket?: unknown;
      objectPath?: unknown;
      contentType?: unknown;
      width?: unknown;
      height?: unknown;
      sizeBytes?: unknown;
      sha256?: unknown;
    };

    if (typeof image.bucket === "string" && typeof image.objectPath === "string") {
      return {
        type: "image",
        assetId: typeof image.assetId === "string" ? image.assetId : undefined,
        storage: {
          bucket: image.bucket,
          objectPath: image.objectPath
        },
        contentType: typeof image.contentType === "string" ? image.contentType : "image/png",
        width: typeof image.width === "number" ? image.width : undefined,
        height: typeof image.height === "number" ? image.height : undefined,
        sizeBytes: typeof image.sizeBytes === "number" ? image.sizeBytes : undefined,
        sha256: typeof image.sha256 === "string" ? image.sha256 : undefined
      };
    }
  }

  return { type: "json", value };
}

function resolveStepInputs(
  step: ExecutionPlanDocument["steps"][number],
  runtimeOutputs: Map<string, Record<string, StepOutputValue>>
) {
  const inputs: Record<string, StepInputValue> = {};

  for (const [handle, port] of Object.entries(step.inputPorts)) {
    if (port.sourceStepId) {
      const sourceOutputs = runtimeOutputs.get(port.sourceStepId);
      const output = sourceOutputs?.[port.sourcePort ?? handle];

      if (!output) {
        throw new GenerationInferenceFailure("STEP_INPUT_UNAVAILABLE", "A required step input is not available.", false);
      }

      inputs[handle] = output;
      continue;
    }

    inputs[handle] = constantInputValue(port.value, port.type);
  }

  return inputs;
}

function generationStatusForStep(step: ExecutionPlanDocument["steps"][number]): GenerationStatus {
  if (step.nodeType === "output") {
    return "UPLOADING";
  }

  if (step.nodeType === "safety-check" || step.nodeType === "image-transform") {
    return "POST_PROCESSING";
  }

  return "GENERATING";
}

function overallProgress(input: { stepIndex: number; stepCount: number; stepProgress: number }) {
  const base = 30;
  const span = 60;
  return Math.min(95, Math.max(base, Math.floor(base + ((input.stepIndex + input.stepProgress / 100) / input.stepCount) * span)));
}

async function markStepRunning(input: {
  payload: WorkerTaskPayload;
  step: ExecutionPlanDocument["steps"][number];
  stepIndex: number;
  stepCount: number;
}) {
  const jobs = await mongoCollection<GenerationJobDocument>(collectionNames.generationJobs);
  const now = new Date();
  const latest = await jobs.findOne({
    _id: input.payload.jobId,
    workflowRevisionId: input.payload.workflowRevisionId,
    "steps.id": input.step.id
  });
  const stepDocument = latest?.steps?.find((step) => step.id === input.step.id);

  if (!latest || !stepDocument) {
    throw new GenerationInferenceFailure("STEP_STATE_NOT_FOUND", "The generation step state was not found.", false);
  }

  if (stepDocument.status === "COMPLETED") {
    return "completed" as const;
  }

  if (latest.status === "CANCELLED") {
    throw new GenerationInferenceFailure("GENERATION_CANCELLED", "Generation was cancelled.", false);
  }

  const attemptNumber = stepDocument.attemptNumber + 1;
  const stepAttempt = {
    id: `${input.step.id}.${attemptNumber}`,
    attemptNumber,
    status: "ACKNOWLEDGED" as const,
    adapterId: input.step.adapterId,
    leaseExpiresAt: stepLeaseExpiresAt(),
    startedAt: now,
    idempotencyKey: `${stepDocument.idempotencyKey}:${attemptNumber}`
  };
  const result = await jobs.updateOne(
    {
      _id: input.payload.jobId,
      workflowRevisionId: input.payload.workflowRevisionId,
      status: { $in: activeGenerationStatuses },
      "attempts.id": input.payload.attemptId,
      steps: {
        $elemMatch: {
          id: input.step.id,
          status: { $in: ["PENDING", "READY", "RUNNING", "FAILED"] }
        }
      }
    },
    {
      $set: {
        status: generationStatusForStep(input.step),
        progress: overallProgress({ stepIndex: input.stepIndex, stepCount: input.stepCount, stepProgress: 1 }),
        "attempts.$.leaseExpiresAt": workerLeaseExpiresAt(),
        "steps.$[step].status": "RUNNING",
        "steps.$[step].progress": 1,
        "steps.$[step].attemptNumber": attemptNumber,
        "steps.$[step].leaseExpiresAt": stepAttempt.leaseExpiresAt,
        "steps.$[step].startedAt": now,
        "steps.$[step].adapterId": input.step.adapterId
      },
      $unset: {
        "steps.$[step].errorCode": "",
        "steps.$[step].errorMessage": ""
      },
      $push: {
        "steps.$[step].attempts": stepAttempt,
        events: event({
          status: generationStatusForStep(input.step),
          progress: overallProgress({ stepIndex: input.stepIndex, stepCount: input.stepCount, stepProgress: 1 }),
          message: `Step ${input.step.nodeId} started.`,
          metadata: {
            attemptId: input.payload.attemptId,
            stepId: input.step.id,
            adapterId: input.step.adapterId,
            modelId: input.step.modelId,
            route: input.step.route
          }
        })
      }
    },
    {
      arrayFilters: [{ "step.id": input.step.id }]
    }
  );

  if (result.modifiedCount !== 1) {
    const refreshed = await jobs.findOne({ _id: input.payload.jobId });
    const refreshedStep = refreshed?.steps?.find((step) => step.id === input.step.id);

    if (refreshedStep?.status === "COMPLETED") {
      return "completed" as const;
    }

    throw new GenerationInferenceFailure("STALE_STEP_CLAIM", "The generation step could not be claimed.", true);
  }

  return "running" as const;
}

async function recordStepProgress(input: {
  payload: WorkerTaskPayload;
  step: ExecutionPlanDocument["steps"][number];
  stepIndex: number;
  stepCount: number;
  update: WorkerProgressUpdate;
}) {
  const jobs = await mongoCollection<GenerationJobDocument>(collectionNames.generationJobs);
  const progress = overallProgress({
    stepIndex: input.stepIndex,
    stepCount: input.stepCount,
    stepProgress: input.update.progress
  });

  await jobs.updateOne(
    {
      _id: input.payload.jobId,
      workflowRevisionId: input.payload.workflowRevisionId,
      status: { $in: activeGenerationStatuses },
      "attempts.id": input.payload.attemptId,
      "steps.id": input.step.id
    },
    {
      $max: {
        progress,
        "steps.$[step].progress": input.update.progress
      },
      $set: {
        status: generationStatusForStep(input.step),
        "attempts.$.leaseExpiresAt": workerLeaseExpiresAt(),
        "steps.$[step].leaseExpiresAt": stepLeaseExpiresAt()
      }
    },
    {
      arrayFilters: [{ "step.id": input.step.id }]
    }
  );
}

async function registerStepImageOutputs(input: {
  payload: WorkerTaskPayload;
  job: GenerationJobDocument;
  step: ExecutionPlanDocument["steps"][number];
  outputs: Record<string, StepOutputValue>;
  artifactRole: "intermediate" | "final";
  session?: ClientSession;
}) {
  const outputArtifactIds: string[] = [];

  for (const [handle, output] of Object.entries(input.outputs)) {
    if (output.type !== "image") {
      continue;
    }

    if (!output.assetId && output.artifact) {
      const registered = await registerGeneratedOutput({
        ownerId: input.job.ownerId,
        jobId: input.job._id,
        attemptId: input.payload.attemptId,
        stepId: input.step.id,
        artifactRole: input.artifactRole,
        artifact: output.artifact,
        session: input.session
      });

      output.assetId = registered.document._id;
    }

    if (output.assetId) {
      outputArtifactIds.push(output.assetId);
    } else if (output.artifact) {
      outputArtifactIds.push(
        buildGeneratedOutputAssetId({
          jobId: input.job._id,
          attemptId: input.payload.attemptId,
          stepId: input.step.id
        })
      );
    }

    input.outputs[handle] = output;
  }

  return Array.from(new Set(outputArtifactIds));
}

async function markStepCompleted(input: {
  payload: WorkerTaskPayload;
  job: GenerationJobDocument;
  step: ExecutionPlanDocument["steps"][number];
  outputs: Record<string, StepOutputValue>;
  usage?: Record<string, unknown>;
  actualCredits: number;
  artifactRole: "intermediate" | "final";
}) {
  const completedAt = new Date();
  const result = await withMongoTransaction(async (session) => {
    const jobs = await mongoCollection<GenerationJobDocument>(collectionNames.generationJobs);
    const job = await jobs.findOne(
      {
        _id: input.payload.jobId,
        workflowRevisionId: input.payload.workflowRevisionId
      },
      { session }
    );

    if (!job) {
      throw new GenerationInferenceFailure("GENERATION_JOB_NOT_FOUND", "The generation job was not found.", false);
    }

    const outputArtifactIds = await registerStepImageOutputs({
      payload: input.payload,
      job,
      step: input.step,
      outputs: input.outputs,
      artifactRole: input.artifactRole,
      session
    });

    const update = await jobs.updateOne(
      {
        _id: input.payload.jobId,
        workflowRevisionId: input.payload.workflowRevisionId,
        status: { $in: activeGenerationStatuses },
        "steps.id": input.step.id
      },
      {
        $set: {
          "steps.$[step].status": "COMPLETED",
          "steps.$[step].progress": 100,
          "steps.$[step].completedAt": completedAt,
          "steps.$[step].outputs": input.outputs,
          "steps.$[step].outputArtifactIds": outputArtifactIds,
          "steps.$[step].usage": {
            ...(input.usage ?? {}),
            actualCredits: input.job.unlimitedDevelopment ? 0 : input.actualCredits
          },
          "steps.$[step].attempts.$[stepAttempt].status": "SUCCEEDED",
          "steps.$[step].attempts.$[stepAttempt].completedAt": completedAt
        },
        $push: {
          events: event({
            id: `${input.payload.jobId}.${input.payload.attemptId}.${input.step.id}.completed`,
            status: generationStatusForStep(input.step),
            progress: input.step.nodeType === "output" ? 95 : 90,
            message: `Step ${input.step.nodeId} completed.`,
            metadata: {
              attemptId: input.payload.attemptId,
              stepId: input.step.id,
              outputArtifactIds
            }
          })
        }
      },
      {
        arrayFilters: [
          { "step.id": input.step.id },
          { "stepAttempt.attemptNumber": job.steps?.find((step) => step.id === input.step.id)?.attemptNumber ?? 0 }
        ],
        session
      }
    );

    if (update.modifiedCount !== 1) {
      throw new GenerationInferenceFailure("STALE_STEP_COMPLETION", "The generation step completion was stale.", true);
    }

    return {
      outputs: input.outputs,
      outputArtifactIds
    };
  });

  return result;
}

async function markStepRetryableFailure(input: {
  payload: WorkerTaskPayload;
  step: ExecutionPlanDocument["steps"][number];
  failure: { errorCode: string; errorMessage: string };
}) {
  const jobs = await mongoCollection<GenerationJobDocument>(collectionNames.generationJobs);
  const now = new Date();

  await jobs.updateOne(
    {
      _id: input.payload.jobId,
      workflowRevisionId: input.payload.workflowRevisionId,
      "steps.id": input.step.id
    },
    {
      $set: {
        "steps.$[step].status": "READY",
        "steps.$[step].progress": 0,
        "steps.$[step].leaseExpiresAt": now,
        "steps.$[step].errorCode": input.failure.errorCode,
        "steps.$[step].errorMessage": input.failure.errorMessage,
        "steps.$[step].attempts.$[stepAttempt].status": "RETRYING",
        "steps.$[step].attempts.$[stepAttempt].completedAt": now,
        "steps.$[step].attempts.$[stepAttempt].errorCode": input.failure.errorCode,
        "steps.$[step].attempts.$[stepAttempt].errorMessage": input.failure.errorMessage
      }
    },
    {
      arrayFilters: [
        { "step.id": input.step.id },
        { "stepAttempt.status": "ACKNOWLEDGED" }
      ]
    }
  );
}

async function markStepFailed(input: {
  payload: WorkerTaskPayload;
  step: ExecutionPlanDocument["steps"][number];
  failure: { errorCode: string; errorMessage: string };
}) {
  const jobs = await mongoCollection<GenerationJobDocument>(collectionNames.generationJobs);
  const now = new Date();

  await jobs.updateOne(
    {
      _id: input.payload.jobId,
      workflowRevisionId: input.payload.workflowRevisionId,
      "steps.id": input.step.id
    },
    {
      $set: {
        "steps.$[step].status": "FAILED",
        "steps.$[step].completedAt": now,
        "steps.$[step].errorCode": input.failure.errorCode,
        "steps.$[step].errorMessage": input.failure.errorMessage,
        "steps.$[step].attempts.$[stepAttempt].status": "FAILED",
        "steps.$[step].attempts.$[stepAttempt].completedAt": now,
        "steps.$[step].attempts.$[stepAttempt].errorCode": input.failure.errorCode,
        "steps.$[step].attempts.$[stepAttempt].errorMessage": input.failure.errorMessage
      }
    },
    {
      arrayFilters: [
        { "step.id": input.step.id },
        { "stepAttempt.status": "ACKNOWLEDGED" }
      ]
    }
  );
}

function finalAssetIdsFromOutputs(outputs: Record<string, StepOutputValue>) {
  return Array.from(
    new Set(
      Object.values(outputs)
        .filter((output): output is Extract<StepOutputValue, { type: "image" }> => output.type === "image")
        .map((output) => output.assetId)
        .filter((assetId): assetId is string => Boolean(assetId))
    )
  );
}

async function executeWorkflowPlan(input: {
  payload: WorkerTaskPayload;
  job: GenerationJobDocument;
  workflowRevision: WorkflowRevisionDocument;
  executionPlan: ExecutionPlanDocument;
}) {
  const jobs = await mongoCollection<GenerationJobDocument>(collectionNames.generationJobs);
  let latestJob = (await jobs.findOne({ _id: input.job._id })) ?? input.job;
  const runtimeOutputs = completedStepOutputs(latestJob);
  const finalAssetIds: string[] = [];
  let actualCredits = 0;

  for (const [index, step] of input.executionPlan.steps.entries()) {
    if (await isGenerationCancelled(input.payload)) {
      throw new GenerationInferenceFailure("GENERATION_CANCELLED", "Generation was cancelled.", false);
    }

    latestJob = (await jobs.findOne({ _id: input.job._id })) ?? latestJob;
    const latestStep = latestJob.steps?.find((candidate) => candidate.id === step.id);

    if (latestStep?.status === "COMPLETED" && latestStep.outputs) {
      runtimeOutputs.set(step.id, latestStep.outputs as Record<string, StepOutputValue>);
      if (step.nodeType === "output") {
        finalAssetIds.push(...(latestStep.outputArtifactIds ?? finalAssetIdsFromOutputs(latestStep.outputs as Record<string, StepOutputValue>)));
      }
      continue;
    }

    const missingDependency = step.dependencies.find((dependency) => !runtimeOutputs.has(dependency));
    if (missingDependency) {
      throw new GenerationInferenceFailure("STEP_DEPENDENCY_INCOMPLETE", "A required step dependency has not completed.", false);
    }

    const claim = await markStepRunning({
      payload: input.payload,
      step,
      stepIndex: index,
      stepCount: input.executionPlan.steps.length
    });

    if (claim === "completed") {
      latestJob = (await jobs.findOne({ _id: input.job._id })) ?? latestJob;
      const completed = latestJob.steps?.find((candidate) => candidate.id === step.id);
      if (completed?.outputs) {
        runtimeOutputs.set(step.id, completed.outputs as Record<string, StepOutputValue>);
      }
      continue;
    }

    try {
      const adapter = getStepExecutionAdapter(step.adapterId);
      const result = await adapter.execute(
        {
          job: latestJob,
          workflowRevision: input.workflowRevision,
          executionPlan: input.executionPlan,
          step,
          inputs: resolveStepInputs(step, runtimeOutputs),
          attemptId: input.payload.attemptId
        },
        {
          progress: async (update) => {
            await recordStepProgress({
              payload: input.payload,
              step,
              stepIndex: index,
              stepCount: input.executionPlan.steps.length,
              update
            });
          },
          isCancelled: () => isGenerationCancelled(input.payload)
        }
      );
      const outputs = normalizeStepOutputs(result.outputs);
      const completed = await markStepCompleted({
        payload: input.payload,
        job: latestJob,
        step,
        outputs,
        usage: result.usage,
        actualCredits: result.actualCredits,
        artifactRole: step.nodeType === "output" ? "final" : "intermediate"
      });

      runtimeOutputs.set(step.id, completed.outputs);
      actualCredits += latestJob.unlimitedDevelopment ? 0 : result.actualCredits;

      if (step.nodeType === "output") {
        finalAssetIds.push(...completed.outputArtifactIds, ...finalAssetIdsFromOutputs(completed.outputs));
      }

      await recordWorkerProgress(input.payload, {
        type: "progress",
        status: step.nodeType === "output" ? "UPLOADING" : "GENERATING",
        progress: overallProgress({
          stepIndex: index + 1,
          stepCount: input.executionPlan.steps.length,
          stepProgress: 100
        }),
        message: `Completed step ${step.nodeId}.`
      });
    } catch (error) {
      const failure = normalizeWorkerFailure(error);
      const latestStepAfterFailure = (await jobs.findOne({ _id: input.job._id }))?.steps?.find(
        (candidate) => candidate.id === step.id
      );
      const attemptsUsed = latestStepAfterFailure?.attemptNumber ?? 1;

      if (failure.errorCode === "GENERATION_CANCELLED") {
        throw error;
      }

      if (failure.retryable && attemptsUsed < step.retryPolicy.maxAttempts && step.retryPolicy.retryable) {
        await markStepRetryableFailure({ payload: input.payload, step, failure });
        throw new GenerationInferenceFailure(failure.errorCode, failure.errorMessage, true);
      }

      if (step.optional) {
        const skipped = await markStepCompleted({
          payload: input.payload,
          job: latestJob,
          step,
          outputs: {
            skipped: {
              type: "json",
              value: {
                skipped: true,
                errorCode: failure.errorCode
              }
            }
          },
          actualCredits: 0,
          artifactRole: "intermediate"
        });
        runtimeOutputs.set(step.id, skipped.outputs);
        continue;
      }

      await markStepFailed({ payload: input.payload, step, failure });
      throw new GenerationInferenceFailure(failure.errorCode, failure.errorMessage, false);
    }
  }

  const uniqueFinalAssetIds = Array.from(new Set(finalAssetIds));

  if (uniqueFinalAssetIds.length === 0) {
    throw new GenerationInferenceFailure("FINAL_OUTPUT_MISSING", "The workflow did not produce a final image output.", false);
  }

  return {
    finalAssetIds: uniqueFinalAssetIds,
    actualCredits: input.job.unlimitedDevelopment ? 0 : actualCredits
  };
}

async function markGenerationAttemptRetrying(
  payload: WorkerTaskPayload,
  failure: { errorCode: string; errorMessage: string }
) {
  const jobs = await mongoCollection<GenerationJobDocument>(collectionNames.generationJobs);
  const now = new Date();
  const job = await jobs.findOneAndUpdate(
    {
      _id: payload.jobId,
      workflowRevisionId: payload.workflowRevisionId,
      status: { $in: activeGenerationStatuses },
      attempts: {
        $elemMatch: {
          id: payload.attemptId,
          status: "ACKNOWLEDGED"
        }
      }
    },
    {
      $set: {
        status: "QUEUED",
        "attempts.$.status": "RETRYING",
        "attempts.$.errorCode": failure.errorCode,
        "attempts.$.errorMessage": failure.errorMessage,
        "attempts.$.leaseExpiresAt": now
      },
      $push: {
        events: event({
          status: "QUEUED",
          progress: 0,
          message: "Generation worker reported a retryable failure.",
          metadata: {
            attemptId: payload.attemptId,
            errorCode: failure.errorCode
          }
        })
      }
    },
    { returnDocument: "after" }
  );

  if (job) {
    await auditWorkerEventOnce({
      job,
      attemptId: payload.attemptId,
      event: "retrying",
      metadata: {
        errorCode: failure.errorCode
      }
    });
  }

  return terminalResult({
    outcome: "retry",
    payload,
    status: job?.status ?? "QUEUED",
    errorCode: failure.errorCode,
    retryable: true
  });
}

async function markGenerationAttemptFailed(
  payload: WorkerTaskPayload,
  failure: { errorCode: string; errorMessage: string }
) {
  const completedAt = new Date();
  const failureEventId = `${payload.jobId}.${payload.attemptId}.failed`;
  const result = await withMongoTransaction(async (session) => {
    const jobs = await mongoCollection<GenerationJobDocument>(collectionNames.generationJobs);
    const job = await jobs.findOne(
      {
        _id: payload.jobId,
        workflowRevisionId: payload.workflowRevisionId
      },
      { session }
    );

    if (!job) {
      return terminalResult({
        outcome: "rejected",
        payload,
        errorCode: "GENERATION_JOB_NOT_FOUND"
      });
    }

    if (job.status === "CANCELLED") {
      return terminalResult({
        outcome: "cancelled",
        payload,
        status: "CANCELLED"
      });
    }

    if (isTerminalGenerationStatus(job.status)) {
      return terminalResult({
        outcome: "duplicate",
        payload,
        status: job.status
      });
    }

    const attempt = job.attempts.find((candidate) => candidate.id === payload.attemptId);

    if (!attempt || terminalAttemptStatuses.includes(attempt.status)) {
      await auditRejectedAttempt({
        payload,
        reason: "stale_failure_update",
        job
      });
      return terminalResult({
        outcome: "rejected",
        payload,
        status: job.status,
        errorCode: "STALE_WORKER_FAILURE"
      });
    }

    const updateResult = await jobs.updateOne(
      {
        _id: payload.jobId,
        workflowRevisionId: payload.workflowRevisionId,
        status: job.status,
        "attempts.id": payload.attemptId
      },
      {
        $set: {
          status: "FAILED",
          errorCode: failure.errorCode,
          errorMessage: failure.errorMessage,
          completedAt,
          "attempts.$.status": "FAILED",
          "attempts.$.errorCode": failure.errorCode,
          "attempts.$.errorMessage": failure.errorMessage,
          "attempts.$.completedAt": completedAt
        }
      },
      { session }
    );
    if (updateResult.modifiedCount !== 1) {
      return terminalResult({
        outcome: "rejected",
        payload,
        status: job.status,
        errorCode: "STALE_WORKER_FAILURE"
      });
    }

    await appendJobEventOnce(
      jobs,
      payload.jobId,
      event({
        id: failureEventId,
        status: "FAILED",
        progress: job.progress,
        message: failure.errorMessage,
        metadata: {
          attemptId: payload.attemptId,
          errorCode: failure.errorCode
        }
      }),
      session
    );
    await refundGenerationCredits({
      userId: job.ownerId,
      jobId: job._id,
      attemptId: payload.attemptId,
      amount: job.reservedCredits ?? job.estimatedCredits,
      reason: failure.errorCode,
      metadata: {
        unlimitedDevelopment: job.unlimitedDevelopment === true,
        executionPlanId: job.executionPlanId,
        executionPlanHash: job.executionPlanHash
      },
      session
    });

    return terminalResult({
      outcome: "failed",
      payload,
      status: "FAILED",
      errorCode: failure.errorCode
    });
  });

  const jobs = await mongoCollection<GenerationJobDocument>(collectionNames.generationJobs);
  const job = await jobs.findOne({ _id: payload.jobId });

  if (job && result.outcome === "failed") {
    await auditWorkerEventOnce({
      job,
      attemptId: payload.attemptId,
      event: "failed",
      metadata: {
        errorCode: failure.errorCode
      }
    });
  }

  return result;
}

async function markGenerationAttemptCancelled(payload: WorkerTaskPayload, reason: string) {
  const completedAt = new Date();
  const cancellationEventId = `${payload.jobId}.${payload.attemptId}.cancelled`;
  const result = await withMongoTransaction(async (session) => {
    const jobs = await mongoCollection<GenerationJobDocument>(collectionNames.generationJobs);
    const job = await jobs.findOne(
      {
        _id: payload.jobId,
        workflowRevisionId: payload.workflowRevisionId
      },
      { session }
    );

    if (!job) {
      return terminalResult({
        outcome: "rejected",
        payload,
        errorCode: "GENERATION_JOB_NOT_FOUND"
      });
    }

    if (job.status !== "CANCELLED" && isTerminalGenerationStatus(job.status)) {
      return terminalResult({
        outcome: "duplicate",
        payload,
        status: job.status
      });
    }

    const attempt = job.attempts.find((candidate) => candidate.id === payload.attemptId);

    if (!attempt || terminalAttemptStatuses.includes(attempt.status)) {
      return terminalResult({
        outcome: "duplicate",
        payload,
        status: job.status
      });
    }

    const updateResult = await jobs.updateOne(
      {
        _id: payload.jobId,
        workflowRevisionId: payload.workflowRevisionId,
        "attempts.id": payload.attemptId
      },
      {
        $set: {
          status: "CANCELLED",
          completedAt,
          "attempts.$.status": "CANCELLED",
          "attempts.$.completedAt": completedAt
        }
      },
      { session }
    );
    if (updateResult.modifiedCount !== 1) {
      return terminalResult({
        outcome: "rejected",
        payload,
        status: job.status,
        errorCode: "STALE_WORKER_CANCELLATION"
      });
    }

    await appendJobEventOnce(
      jobs,
      payload.jobId,
      event({
        id: cancellationEventId,
        status: "CANCELLED",
        progress: job.progress,
        message: reason,
        metadata: {
          attemptId: payload.attemptId
        }
      }),
      session
    );
    await refundGenerationCredits({
      userId: job.ownerId,
      jobId: job._id,
      attemptId: payload.attemptId,
      amount: job.reservedCredits ?? job.estimatedCredits,
      reason: "cancelled",
      metadata: {
        unlimitedDevelopment: job.unlimitedDevelopment === true,
        executionPlanId: job.executionPlanId,
        executionPlanHash: job.executionPlanHash
      },
      session
    });

    return terminalResult({
      outcome: "cancelled",
      payload,
      status: "CANCELLED"
    });
  });

  const jobs = await mongoCollection<GenerationJobDocument>(collectionNames.generationJobs);
  const job = await jobs.findOne({ _id: payload.jobId });

  if (job) {
    await auditWorkerEventOnce({
      job,
      attemptId: payload.attemptId,
      event: "cancelled"
    });
  }

  return result;
}

async function completeGenerationAttempt(
  payload: WorkerTaskPayload,
  finalAssetIds: string[],
  actualCredits: number
) {
  const completedAt = new Date();
  const completionEventId = `${payload.jobId}.${payload.attemptId}.completed`;
  const result = await withMongoTransaction(async (session) => {
    const jobs = await mongoCollection<GenerationJobDocument>(collectionNames.generationJobs);
    const job = await jobs.findOne(
      {
        _id: payload.jobId,
        workflowRevisionId: payload.workflowRevisionId
      },
      { session }
    );

    if (!job) {
      return terminalResult({
        outcome: "rejected",
        payload,
        errorCode: "GENERATION_JOB_NOT_FOUND"
      });
    }

    if (job.status === "CANCELLED") {
      return terminalResult({
        outcome: "cancelled",
        payload,
        status: "CANCELLED"
      });
    }

    if (isTerminalGenerationStatus(job.status)) {
      return terminalResult({
        outcome: "duplicate",
        payload,
        status: job.status
      });
    }

    if (!isLegalGenerationTransition(job.status, "COMPLETED")) {
      await auditRejectedAttempt({
        payload,
        reason: "illegal_completion_transition",
        job
      });
      return terminalResult({
        outcome: "rejected",
        payload,
        status: job.status,
        errorCode: "ILLEGAL_STATUS_TRANSITION"
      });
    }

    const attempt = job.attempts.find((candidate) => candidate.id === payload.attemptId);

    if (!attempt || attempt.status !== "ACKNOWLEDGED") {
      await auditRejectedAttempt({
        payload,
        reason: "stale_completion_update",
        job
      });
      return terminalResult({
        outcome: "rejected",
        payload,
        status: job.status,
        errorCode: "STALE_WORKER_COMPLETION"
      });
    }

    const updateResult = await jobs.updateOne(
      {
        _id: payload.jobId,
        workflowRevisionId: payload.workflowRevisionId,
        status: job.status,
        "attempts.id": payload.attemptId
      },
      {
        $set: {
          status: "COMPLETED",
          progress: 100,
          completedAt,
          "attempts.$.status": "SUCCEEDED",
          "attempts.$.completedAt": completedAt,
          "attempts.$.metadata": {
            finalAssetIds
          }
        }
      },
      { session }
    );
    if (updateResult.modifiedCount !== 1) {
      return terminalResult({
        outcome: "rejected",
        payload,
        status: job.status,
        errorCode: "STALE_WORKER_COMPLETION"
      });
    }

    await appendJobEventOnce(
      jobs,
      payload.jobId,
      event({
        id: completionEventId,
        status: "COMPLETED",
        progress: 100,
        message: job.unlimitedDevelopment
          ? "Development unlimited generation completed with private placeholder-safe accounting."
          : "Generation completed.",
        metadata: {
          attemptId: payload.attemptId,
          finalAssetIds,
          executionPlanId: job.executionPlanId,
          executionPlanHash: job.executionPlanHash,
          unlimitedDevelopment: job.unlimitedDevelopment === true
        }
      }),
      session
    );
    await captureGenerationCredits({
      userId: job.ownerId,
      jobId: job._id,
      attemptId: payload.attemptId,
      amount: actualCredits,
      reservedCredits: job.reservedCredits,
      metadata: {
        unlimitedDevelopment: job.unlimitedDevelopment === true,
        executionPlanId: job.executionPlanId,
        executionPlanHash: job.executionPlanHash,
        monetaryChargeCents: job.unlimitedDevelopment ? 0 : undefined
      },
      session
    });

    return terminalResult({
      outcome: "completed",
      payload,
      status: "COMPLETED"
    });
  });

  const jobs = await mongoCollection<GenerationJobDocument>(collectionNames.generationJobs);
  const job = await jobs.findOne({ _id: payload.jobId });

  if (job && result.outcome === "completed") {
    await auditWorkerEventOnce({
      job,
      attemptId: payload.attemptId,
      event: "completed",
      metadata: {
        finalAssetIds,
        executionPlanId: job.executionPlanId,
        executionPlanHash: job.executionPlanHash,
        unlimitedDevelopment: job.unlimitedDevelopment === true
      }
    });
  }

  return result;
}

export async function runGenerationWorkerTask(payload: WorkerTaskPayload): Promise<GenerationWorkerRunResult> {
  const jobs = await mongoCollection<GenerationJobDocument>(collectionNames.generationJobs);
  const job = await jobs.findOne({ _id: payload.jobId, workflowRevisionId: payload.workflowRevisionId });
  if (job?.verificationModelId) return withModelVerification(job.verificationModelId, () => executeGenerationWorkerTask(payload));
  return executeGenerationWorkerTask(payload);
}

async function executeGenerationWorkerTask(payload: WorkerTaskPayload): Promise<GenerationWorkerRunResult> {
  const claim = await claimGenerationAttempt(payload);

  if (!claim.claimed) {
    return claim.result;
  }

  try {
    const starting = await recordWorkerProgress(payload, {
      type: "progress",
      status: "STARTING",
      progress: 15,
      message: "Generation worker is loading authoritative job state."
    });

    if (starting) {
      return starting;
    }

    if (await isGenerationCancelled(payload)) {
      return markGenerationAttemptCancelled(payload, "Generation was cancelled.");
    }

    const context = await loadExecutionContext(payload, claim.job);
    const loading = await recordWorkerProgress(payload, {
      type: "progress",
      status: "LOADING_MODEL",
      progress: 30,
      message: "Generation worker is preparing the selected model."
    });

    if (loading) {
      return loading;
    }

    const executionResult = await executeWorkflowPlan({
      payload,
      job: context.job,
      workflowRevision: context.workflowRevision,
      executionPlan: context.executionPlan
    });

    if (await isGenerationCancelled(payload)) {
      return markGenerationAttemptCancelled(payload, "Generation was cancelled.");
    }

    const uploading = await recordWorkerProgress(payload, {
      type: "progress",
      status: "UPLOADING",
      progress: 95,
      message: "Generation worker is registering private output."
    });

    if (uploading) {
      return uploading;
    }

    return completeGenerationAttempt(payload, executionResult.finalAssetIds, executionResult.actualCredits);
  } catch (error) {
    const failure = normalizeWorkerFailure(error);

    if (failure.errorCode === "GENERATION_CANCELLED") {
      return markGenerationAttemptCancelled(payload, failure.errorMessage);
    }

    if (failure.retryable) {
      return markGenerationAttemptRetrying(payload, failure);
    }

    return markGenerationAttemptFailed(payload, failure);
  }
}
