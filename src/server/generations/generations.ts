import "server-only";

import { nanoid } from "nanoid";
import { assertNotSuspended, type AppRole } from "@/server/auth/roles";
import { writeAuditEvent } from "@/server/audit/audit";
import { reserveGenerationCredits, refundGenerationCredits } from "@/server/credits/ledger";
import { conflict, configurationRequired, notFound, validationFailed, AppError } from "@/server/errors";
import { enqueueGenerationTask, assertCloudTasksConfigured } from "@/server/gcp/tasks";
import { getWorkflowModelIds, validateWorkflow } from "@/lib/workflow/schema";
import type { WorkflowExecutionEnvironment } from "@/lib/workflow/schema";
import { getGenerationEntitlement } from "@/server/entitlements/development";
import { requireEnabledModels } from "@/server/models/models";
import { createWorkflowVersion } from "@/server/workflows/workflows";
import { mongoCollection, withMongoTransaction } from "@/server/db/mongodb";
import { createWorkerTaskPayload } from "@/server/generations/worker-contract";
import { isLocalGenerationWorkerEnabled, missingLocalGenerationWorkerEnv } from "@/server/generations/worker-config";
import { GenerationInferenceFailure, assertStepExecutionAdapterConfigured } from "@/server/generations/inference-adapters";
import { activeGenerationStatuses, terminalAttemptStatuses } from "@/server/generations/lifecycle-rules";
import { recordGenerationDispatchAudit, runGenerationWorkerTask } from "@/server/generations/worker";
import { redactForLogging } from "@/lib/security/redaction";
import {
  collectionNames,
  type AssetDocument,
  type GenerationAttemptDocument,
  type GenerationJobDocument,
  type GenerationJobEventDocument,
  type GenerationStatus,
  type WorkflowRevisionDocument
} from "@/server/db/types";
import { compileAndPersistExecutionPlan, createInitialGenerationSteps } from "@/server/workflows/compiler";
import { generationSetupIssue } from "@/server/generations/readiness";
import { hasProviderCredential } from "@/server/providers/credentials";
import { isVerifyingModel } from "@/server/models/verification-context";
import { ollamaImageModelId } from "@/lib/models/ollama-image";
import { huggingFaceImageModel } from "@/lib/models/huggingface-image";

export type GenerationJobDTO = {
  id: string;
  status: GenerationStatus;
  progress: number;
  modelId?: string;
  modelIds?: string[];
  executionEnvironment?: WorkflowExecutionEnvironment;
  routeSummary?: string[];
  workflowId?: string;
  workflowVersionId: string;
  executionPlanId?: string;
  executionPlanVersion?: number;
  executionPlanHash?: string;
  estimatedCredits: number;
  reservedCredits?: number;
  unlimitedDevelopment?: boolean;
  errorCode?: string;
  errorMessage?: string;
  steps?: {
    id: string;
    nodeId: string;
    nodeType: string;
    status: string;
    progress: number;
    modelId?: string;
    route?: string;
    adapterId: string;
    outputArtifactIds?: string[];
    errorCode?: string;
    errorMessage?: string;
  }[];
  createdAt: string;
  startedAt?: string;
  completedAt?: string;
};

function toJobDTO(job: GenerationJobDocument): GenerationJobDTO {
  return {
    id: job._id,
    status: job.status,
    progress: job.progress,
    modelId: job.modelId,
    modelIds: job.modelIds,
    executionEnvironment: job.executionEnvironment,
    routeSummary: job.routeSummary,
    workflowId: job.workflowId,
    workflowVersionId: job.workflowRevisionId,
    executionPlanId: job.executionPlanId,
    executionPlanVersion: job.executionPlanVersion,
    executionPlanHash: job.executionPlanHash,
    estimatedCredits: job.estimatedCredits,
    reservedCredits: job.reservedCredits,
    unlimitedDevelopment: job.unlimitedDevelopment,
    errorCode: job.errorCode,
    errorMessage: job.errorMessage,
    steps: job.steps?.map((step) => ({
      id: step.id,
      nodeId: step.nodeId,
      nodeType: step.nodeType,
      status: step.status,
      progress: step.progress,
      modelId: step.modelId,
      route: step.route,
      adapterId: step.adapterId,
      outputArtifactIds: step.outputArtifactIds,
      errorCode: step.errorCode,
      errorMessage: step.errorMessage
    })),
    createdAt: job.createdAt.toISOString(),
    startedAt: job.startedAt?.toISOString(),
    completedAt: job.completedAt?.toISOString()
  };
}

function toJobEventDTO(event: GenerationJobEventDocument) {
  return {
    id: event.id,
    status: event.status,
    progress: event.progress,
    message: event.message,
    createdAt: event.createdAt.toISOString()
  };
}

function assertGenerationDispatchConfigured() {
  if (isLocalGenerationWorkerEnabled()) {
    const missing = missingLocalGenerationWorkerEnv();

    if (missing.length > 0) {
      throw new AppError("CONFIGURATION_REQUIRED", "Local generation worker mode is not configured.", 503, {
        missing
      });
    }

    return;
  }

  assertCloudTasksConfigured();
}

function assertPlanAdaptersConfigured(plan: { steps: { adapterId: string }[] }) {
  const adapterIds = Array.from(new Set(plan.steps.map((step) => step.adapterId)));

  try {
    for (const adapterId of adapterIds) {
      assertStepExecutionAdapterConfigured(adapterId);
    }
  } catch (error) {
    if (error instanceof GenerationInferenceFailure) {
      throw configurationRequired(error.safeMessage, {
        errorCode: error.code,
        retryable: error.retryable
      });
    }

    throw error;
  }
}

async function dispatchGenerationAttempt(input: {
  jobId: string;
  workflowVersionId: string;
  attemptId: string;
}): Promise<{
  taskName: string;
  dispatchMode: "cloud-tasks" | "local";
  runAfterDispatch?: () => void;
}> {
  const payload = createWorkerTaskPayload({
    jobId: input.jobId,
    workflowRevisionId: input.workflowVersionId,
    attemptId: input.attemptId
  });

  if (isLocalGenerationWorkerEnabled()) {
    return {
      taskName: `local-generation-worker/${input.jobId}/${input.attemptId}`,
      dispatchMode: "local" as const,
      runAfterDispatch: () => {
        setTimeout(() => {
          runGenerationWorkerTask(payload).catch((error) => {
            console.error("Local generation worker failed", redactForLogging({ error, jobId: input.jobId }));
          });
        }, 0);
      }
    };
  }

  const taskName = await enqueueGenerationTask(input);

  return {
    taskName,
    dispatchMode: "cloud-tasks" as const
  };
}

export async function listGenerationJobs(ownerId: string) {
  const jobs = await mongoCollection<GenerationJobDocument>(collectionNames.generationJobs);
  const records = await jobs.find({ ownerId }).sort({ createdAt: -1 }).limit(50).toArray();

  return records.map(toJobDTO);
}

export async function getGenerationJob(ownerId: string, jobId: string) {
  const jobs = await mongoCollection<GenerationJobDocument>(collectionNames.generationJobs);
  const assets = await mongoCollection<AssetDocument>(collectionNames.assets);
  const job = await jobs.findOne({
    _id: jobId,
    ownerId
  });

  if (!job) {
    throw notFound("Generation job not found.");
  }

  const jobAssets = await assets
    .find({
      ownerId,
      generationJobId: job._id,
      deletedAt: { $exists: false }
    })
    .sort({ createdAt: 1 })
    .toArray();

  return {
    ...toJobDTO(job),
    assets: jobAssets.map((asset) => ({
      id: asset._id,
      kind: asset.kind,
      contentType: asset.contentType,
      width: asset.width,
      height: asset.height,
      createdAt: asset.createdAt.toISOString()
    })),
    events: job.events.slice(0, 100).map(toJobEventDTO)
  };
}

export async function getGenerationJobEvents(ownerId: string, jobId: string) {
  const jobs = await mongoCollection<GenerationJobDocument>(collectionNames.generationJobs);
  const job = await jobs.findOne({
    _id: jobId,
    ownerId
  });

  if (!job) {
    throw notFound("Generation job not found.");
  }

  return {
    snapshot: {
      status: job.status,
      progress: job.progress
    },
    events: job.events.slice(0, 100).map(toJobEventDTO)
  };
}

export async function createGenerationJob(input: {
  ownerId: string;
  role: AppRole;
  workflow: unknown;
  workflowId?: string;
  workflowName: string;
  idempotencyKey: string;
}) {
  assertNotSuspended(input.role);
  assertGenerationDispatchConfigured();

  const structuralValidation = validateWorkflow(input.workflow);
  if (!structuralValidation.ok) {
    throw validationFailed("Workflow validation failed.", { issues: structuralValidation.issues });
  }

  const models = await requireEnabledModels(getWorkflowModelIds(structuralValidation.workflow));
  const environment = structuralValidation.workflow.executionEnvironment;
  const allowed = environment === "gcp-hosted" ? models.every((model) => model.id === ollamaImageModelId && model.route === "gcp-hosted-gpu") : environment === "huggingface-l4" && models.every((model) => Boolean(huggingFaceImageModel(model.id)) && model.route === "huggingface-image");
  if (!allowed) throw validationFailed("Select a reviewed model in the Ollama or Hugging Face L4 environment.");
  for (const model of models) {
    const setupIssue = generationSetupIssue(model.route);
    if (setupIssue) throw configurationRequired(setupIssue);
    if (model.route === "google-ai-studio-image" && !(await hasProviderCredential(input.ownerId, model.providerId))) throw configurationRequired("Save your Google AI Studio API key in BYOK Providers before generation.");
  }
  const validation = validateWorkflow(input.workflow, {
    models: models.map((model) => ({
      id: model.id,
      name: model.displayName,
      route: model.route,
      maxPixels: model.maxPixels,
      maxSteps: model.maxSteps,
      baseCreditCost: model.baseCreditCost,
      isEnabled: model.isEnabled,
      capabilities: model.capabilities
    }))
  });

  if (!validation.ok) {
    throw validationFailed("Workflow validation failed.", { issues: validation.issues });
  }

  const jobs = await mongoCollection<GenerationJobDocument>(collectionNames.generationJobs);
  const existing = await jobs.findOne({
    ownerId: input.ownerId,
    idempotencyKey: input.idempotencyKey
  });

  if (existing) {
    return { job: toJobDTO(existing), idempotentReplay: true };
  }

  const activeCount = await jobs.countDocuments({
    ownerId: input.ownerId,
    status: { $in: activeGenerationStatuses }
  });
  const maxActive = Number(process.env.MAX_ACTIVE_GENERATIONS_PER_USER ?? 3);

  if (activeCount >= maxActive) {
    throw new AppError("RATE_LIMITED", "The account already has the maximum active generation jobs.", 429, {
      maxActive
    });
  }

  const workflowResult = await createWorkflowVersion({
    ownerId: input.ownerId,
    workflowId: input.workflowId,
    name: input.workflowName,
    workflow: validation.workflow
  });
  const revisions = await mongoCollection<WorkflowRevisionDocument>(collectionNames.workflowRevisions);
  const workflowRevision = await revisions.findOne({
    _id: workflowResult.version.id,
    ownerId: input.ownerId
  });

  if (!workflowRevision) {
    throw notFound("Workflow revision not found after save.");
  }

  const plan = await compileAndPersistExecutionPlan({
    ownerId: input.ownerId,
    workflowRevision
  });
  assertPlanAdaptersConfigured(plan);
  const entitlement = getGenerationEntitlement();
  const credits = plan.estimates.credits;
  const reservedCredits = entitlement.unlimitedDevelopment ? (entitlement.reservedCredits ?? 0) : credits;
  const primaryModelId = plan.modelIds[0];
  const now = new Date();
  const attempt: GenerationAttemptDocument = {
    id: nanoid(),
    attemptNumber: 1,
    status: "CREATED",
    metadata: {
      executionPlanId: plan._id,
      executionPlanHash: plan.planHash
    }
  };
  const jobId = nanoid();
  const job: GenerationJobDocument = {
    _id: jobId,
    ...(models.length === 1 && isVerifyingModel(models[0].id) ? { verificationModelId: models[0].id } : {}),
    ownerId: input.ownerId,
    workflowId: workflowResult.workflow.id,
    workflowRevisionId: workflowResult.version.id,
    executionPlanId: plan._id,
    executionPlanVersion: plan.version,
    executionPlanHash: plan.planHash,
    modelId: primaryModelId,
    modelIds: plan.modelIds,
    executionEnvironment: plan.executionEnvironment,
    routeSummary: plan.routeSummary,
    idempotencyKey: input.idempotencyKey,
    status: "QUEUED",
    progress: 0,
    estimatedCredits: credits,
    reservedCredits,
    unlimitedDevelopment: entitlement.unlimitedDevelopment,
    steps: createInitialGenerationSteps({ plan, jobId, attemptId: attempt.id }),
    attempts: [attempt],
    events: [
      {
        id: nanoid(),
        status: "QUEUED",
        progress: 0,
        message: "Generation accepted and waiting for worker dispatch.",
        metadata: {
          modelIds: plan.modelIds,
          executionEnvironment: plan.executionEnvironment,
          routeSummary: plan.routeSummary,
          workflowVersionId: workflowResult.version.id,
          executionPlanId: plan._id,
          executionPlanHash: plan.planHash,
          unlimitedDevelopment: entitlement.unlimitedDevelopment
        },
        createdAt: now
      }
    ],
    createdAt: now
  };

  try {
    await withMongoTransaction(async (session) => {
      await jobs.insertOne(job, { session });
      await reserveGenerationCredits({
        userId: input.ownerId,
        jobId: job._id,
        amount: reservedCredits,
        workflowRevisionId: workflowResult.version.id,
        modelId: primaryModelId,
        metadata: {
          modelIds: plan.modelIds,
          executionEnvironment: plan.executionEnvironment,
          executionPlanId: plan._id,
          executionPlanHash: plan.planHash,
          unlimitedDevelopment: entitlement.unlimitedDevelopment,
          monetaryChargeCents: entitlement.monetaryChargeCents
        },
        session
      });
    });
  } catch (error) {
    const replay = await jobs.findOne({
      ownerId: input.ownerId,
      idempotencyKey: input.idempotencyKey
    });

    if (replay) {
      return { job: toJobDTO(replay), idempotentReplay: true };
    }

    throw error;
  }

  try {
    const dispatch = await dispatchGenerationAttempt({
      jobId: job._id,
      workflowVersionId: workflowResult.version.id,
      attemptId: attempt.id
    });
    const dispatchedAt = new Date();

    const dispatchUpdate = await jobs.updateOne(
      { _id: job._id, "attempts.id": attempt.id },
      {
        $set: {
          "attempts.$.taskName": dispatch.taskName,
          "attempts.$.status": "DISPATCHED",
          "attempts.$.dispatchedAt": dispatchedAt
        },
        $push: {
          events: {
            id: `${job._id}.${attempt.id}.dispatched`,
            status: "QUEUED",
            progress: 0,
            message:
              dispatch.dispatchMode === "local"
                ? "Generation dispatched to the local development worker."
                : "Generation dispatched to Cloud Tasks.",
            metadata: {
              attemptId: attempt.id,
              dispatchMode: dispatch.dispatchMode,
              executionEnvironment: plan.executionEnvironment
            },
            createdAt: dispatchedAt
          }
        }
      }
    );

    if (dispatchUpdate.modifiedCount !== 1) {
      throw conflict("Generation dispatch state changed unexpectedly.");
    }

    await recordGenerationDispatchAudit({
      job,
      attemptId: attempt.id,
      taskName: dispatch.taskName,
      dispatchMode: dispatch.dispatchMode
    });
    dispatch.runAfterDispatch?.();
  } catch (error) {
    const safeMessage = "Generation dispatch failed.";
    const completedAt = new Date();
    await withMongoTransaction(async (session) => {
      await jobs.updateOne(
        { _id: job._id, "attempts.id": attempt.id },
        {
          $set: {
            status: "FAILED",
            errorCode: "TASK_DISPATCH_FAILED",
            errorMessage: safeMessage,
            completedAt,
            "attempts.$.status": "FAILED",
            "attempts.$.errorCode": "TASK_DISPATCH_FAILED",
            "attempts.$.errorMessage": safeMessage,
            "attempts.$.completedAt": completedAt
          },
          $push: {
            events: {
              id: `${job._id}.${attempt.id}.dispatch-failed`,
              status: "FAILED",
              progress: 0,
              message: safeMessage,
              metadata: {
                errorCode: "TASK_DISPATCH_FAILED"
              },
              createdAt: completedAt
            }
          }
        },
        { session }
      );
      await refundGenerationCredits({
        userId: input.ownerId,
        jobId: job._id,
        attemptId: attempt.id,
        amount: reservedCredits,
        reason: "TASK_DISPATCH_FAILED",
        metadata: {
          unlimitedDevelopment: entitlement.unlimitedDevelopment,
          executionEnvironment: plan.executionEnvironment,
          executionPlanId: plan._id,
          executionPlanHash: plan.planHash
        },
        session
      });
    });
    await writeAuditEvent({
      userId: input.ownerId,
      eventType: "generation.worker.failed",
      targetType: "generation_job",
      targetId: job._id,
      referenceId: `${job._id}.${attempt.id}.dispatch-failed.audit`,
      metadata: {
        attemptId: attempt.id,
        workflowRevisionId: workflowResult.version.id,
        modelIds: plan.modelIds,
        executionEnvironment: plan.executionEnvironment,
        executionPlanId: plan._id,
        executionPlanHash: plan.planHash,
        unlimitedDevelopment: entitlement.unlimitedDevelopment,
        errorCode: "TASK_DISPATCH_FAILED"
      }
    });
    console.error("Generation dispatch failed", redactForLogging({ error, jobId: job._id }));
    throw new AppError("UPSTREAM_FAILED", safeMessage, 502);
  }

  return { job: toJobDTO(job), idempotentReplay: false };
}

export async function cancelGenerationJob(ownerId: string, jobId: string) {
  const jobs = await mongoCollection<GenerationJobDocument>(collectionNames.generationJobs);
  let updated: GenerationJobDocument | null = null;

  await withMongoTransaction(async (session) => {
    const job = await jobs.findOne(
      {
        _id: jobId,
        ownerId
      },
      { session }
    );

    if (!job) {
      throw notFound("Generation job not found.");
    }

    if (!activeGenerationStatuses.includes(job.status)) {
      throw conflict("Only active generation jobs can be cancelled.");
    }

    const now = new Date();
    updated = await jobs.findOneAndUpdate(
      {
        _id: job._id,
        ownerId,
        status: { $in: activeGenerationStatuses }
      },
      {
        $set: {
          status: "CANCELLED",
          completedAt: now,
          "attempts.$[attempt].status": "CANCELLED",
          "attempts.$[attempt].completedAt": now,
          "steps.$[step].status": "CANCELLED",
          "steps.$[step].completedAt": now
        },
        $push: {
          events: {
            id: `${job._id}.cancelled`,
            status: "CANCELLED",
            progress: job.progress,
            message: "Cancellation requested by user.",
            createdAt: now
          }
        }
      },
      {
        arrayFilters: [
          { "attempt.status": { $nin: terminalAttemptStatuses } },
          { "step.status": { $nin: ["COMPLETED", "FAILED", "SKIPPED", "CANCELLED"] } }
        ],
        returnDocument: "after",
        session
      }
    );

    if (!updated) {
      throw conflict("Only active generation jobs can be cancelled.");
    }

    await refundGenerationCredits({
      userId: ownerId,
      jobId: job._id,
        attemptId: job.attempts[0]?.id,
        amount: job.reservedCredits ?? job.estimatedCredits,
        reason: "cancelled",
        metadata: {
          unlimitedDevelopment: job.unlimitedDevelopment === true,
          executionPlanId: job.executionPlanId,
          executionPlanHash: job.executionPlanHash
        },
        session
      });
  });

  if (!updated) {
    throw notFound("Generation job not found.");
  }

  return toJobDTO(updated);
}
