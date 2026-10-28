import assert from "node:assert/strict";
import Module from "node:module";
import path from "node:path";
import test from "node:test";
import { createGeneratedOutputAssetDraft, buildGeneratedOutputAssetId } from "../src/server/assets/generated-output-contract";
import {
  createWorkerTaskPayload,
  workerTaskPayloadSchema,
  workerUpdatePayloadSchema
} from "../src/server/generations/worker-contract";
import { authenticateGenerationWorkerRequest } from "../src/server/generations/worker-auth";
import {
  canClaimAttempt,
  generationAuditReference,
  generationCreditReference,
  isLegalGenerationTransition
} from "../src/server/generations/lifecycle-rules";
import { redactForLogging } from "../src/lib/security/redaction";

const validTask = createWorkerTaskPayload({
  jobId: "job_123",
  workflowRevisionId: "revision_123",
  attemptId: "attempt_123"
});

async function loadInferenceAdapters() {
  const loader = Module as unknown as {
    _load(request: string, parent: unknown, isMain: boolean): unknown;
  };
  const originalLoad = loader._load;

  loader._load = function patchedLoad(request, parent, isMain) {
    if (request === "server-only") {
      return {};
    }

    if (request.startsWith("@/")) {
      return originalLoad.call(this, path.join(process.cwd(), "src", request.slice(2)), parent, isMain);
    }

    return originalLoad.call(this, request, parent, isMain);
  };

  try {
    return (await import("../src/server/generations/inference-adapters")) as typeof import("../src/server/generations/inference-adapters");
  } finally {
    loader._load = originalLoad;
  }
}

test("worker task payload rejects malformed and overbroad input", () => {
  assert.equal(workerTaskPayloadSchema.safeParse(validTask).success, true);
  assert.equal(workerTaskPayloadSchema.safeParse({ ...validTask, ownerId: "user_123" }).success, false);
  assert.equal(workerTaskPayloadSchema.safeParse({ ...validTask, modelId: "model_123" }).success, false);
  assert.equal(workerTaskPayloadSchema.safeParse({ ...validTask, version: 2 }).success, false);
  assert.equal(workerTaskPayloadSchema.safeParse({ ...validTask, jobId: "../not-safe" }).success, false);
});

test("worker update contract accepts only bounded progress and completion payloads", () => {
  const completed = workerUpdatePayloadSchema.parse({
    contract: "astraflow.generation.worker-update",
    version: 1,
    jobId: validTask.jobId,
    attemptId: validTask.attemptId,
    update: {
      type: "completed",
      progress: 100,
      actualCredits: 4,
      output: {
        contentType: "image/png",
        width: 768,
        height: 768,
        sizeBytes: 128,
        sha256: "a".repeat(64),
        storage: {
          bucket: "local-dev-generated-output",
          objectPath: "outputs/owner/job/attempt.png"
        },
        developmentOnly: true
      }
    }
  });

  assert.equal(completed.update.type, "completed");
  assert.equal(
    workerUpdatePayloadSchema.safeParse({
      ...completed,
      update: {
        type: "progress",
        status: "COMPLETED",
        progress: 100
      }
    }).success,
    false
  );
});

test("deployed worker auth rejects missing, wrong, and accepts expected OIDC identity", async () => {
  const config = {
    localWorkerEnabled: false,
    expectedAudience: "https://worker.example/run",
    expectedServiceAccountEmail: "tasks@example.iam.gserviceaccount.com",
    nodeEnv: "production"
  };

  assert.deepEqual(await authenticateGenerationWorkerRequest(new Headers(), { config }), {
    ok: false,
    status: 401,
    code: "WORKER_AUTH_REQUIRED"
  });

  const wrongIssuer = await authenticateGenerationWorkerRequest(
    new Headers({ authorization: "Bearer signed-token" }),
    {
      config,
      verifyOidcToken: async () => ({
        iss: "https://issuer.invalid",
        aud: config.expectedAudience,
        email: config.expectedServiceAccountEmail,
        email_verified: true
      })
    }
  );
  assert.equal(wrongIssuer.ok, false);

  let verifiedAudience: string | undefined;
  const accepted = await authenticateGenerationWorkerRequest(
    new Headers({ authorization: "Bearer signed-token" }),
    {
      config,
      verifyOidcToken: async ({ audience }) => {
        verifiedAudience = audience;
        return {
          iss: "https://accounts.google.com",
          aud: config.expectedAudience,
          email: config.expectedServiceAccountEmail,
          email_verified: true
        };
      }
    }
  );

  assert.equal(accepted.ok, true);
  assert.equal(verifiedAudience, config.expectedAudience);
  assert.equal(accepted.ok && accepted.identity.mode, "oidc");
});

test("local worker mode requires an explicit non-production shared secret", async () => {
  const config = {
    localWorkerEnabled: true,
    localSecret: "dev-worker-secret",
    nodeEnv: "development"
  };

  assert.equal((await authenticateGenerationWorkerRequest(new Headers(), { config })).ok, false);
  assert.equal(
    (
      await authenticateGenerationWorkerRequest(
        new Headers({ "x-astraflow-local-worker-secret": "dev-worker-secret" }),
        { config }
      )
    ).ok,
    true
  );

  const productionLocalBypass = await authenticateGenerationWorkerRequest(
    new Headers({ "x-astraflow-local-worker-secret": "dev-worker-secret" }),
    {
      config: {
        ...config,
        nodeEnv: "production"
      }
    }
  );

  assert.equal(productionLocalBypass.ok, false);
  assert.equal(productionLocalBypass.ok ? "" : productionLocalBypass.code, "WORKER_AUTH_CONFIG_REQUIRED");
});

test("attempt claim rules reject terminal, stale, and concurrently active attempts", () => {
  const now = new Date("2026-09-09T12:00:00Z");
  const past = new Date(now.getTime() - 1000);
  const future = new Date(now.getTime() + 1000);

  assert.deepEqual(
    canClaimAttempt({
      jobStatus: "COMPLETED",
      jobWorkflowRevisionId: "rev",
      payloadWorkflowRevisionId: "rev",
      attempts: [{ id: "attempt", status: "DISPATCHED" }],
      attemptId: "attempt",
      now
    }),
    { ok: false, reason: "terminal_job" }
  );
  assert.deepEqual(
    canClaimAttempt({
      jobStatus: "QUEUED",
      jobWorkflowRevisionId: "rev",
      payloadWorkflowRevisionId: "other_rev",
      attempts: [{ id: "attempt", status: "DISPATCHED" }],
      attemptId: "attempt",
      now
    }),
    { ok: false, reason: "workflow_revision_mismatch" }
  );
  assert.deepEqual(
    canClaimAttempt({
      jobStatus: "QUEUED",
      jobWorkflowRevisionId: "rev",
      payloadWorkflowRevisionId: "rev",
      attempts: [{ id: "attempt", status: "ACKNOWLEDGED", leaseExpiresAt: future }],
      attemptId: "attempt",
      now
    }),
    { ok: false, reason: "attempt_already_active" }
  );
  assert.deepEqual(
    canClaimAttempt({
      jobStatus: "QUEUED",
      jobWorkflowRevisionId: "rev",
      payloadWorkflowRevisionId: "rev",
      attempts: [{ id: "attempt", status: "ACKNOWLEDGED", leaseExpiresAt: past }],
      attemptId: "attempt",
      now
    }),
    { ok: true, staleLease: true }
  );
});

test("generation status transitions are one-way once terminal", () => {
  assert.equal(isLegalGenerationTransition("QUEUED", "VALIDATING"), true);
  assert.equal(isLegalGenerationTransition("GENERATING", "UPLOADING"), true);
  assert.equal(isLegalGenerationTransition("GENERATING", "VALIDATING"), false);
  assert.equal(isLegalGenerationTransition("COMPLETED", "GENERATING"), false);
  assert.equal(isLegalGenerationTransition("FAILED", "QUEUED"), false);
});

test("credit, audit, and asset references are deterministic for duplicate delivery", () => {
  assert.equal(generationCreditReference("job_123", "reservation"), "generation:job_123:reservation");
  assert.equal(generationCreditReference("job_123", "capture"), generationCreditReference("job_123", "capture"));
  assert.equal(generationCreditReference("job_123", "refund"), generationCreditReference("job_123", "refund"));
  assert.notEqual(generationCreditReference("job_123", "capture"), generationCreditReference("job_123", "refund"));
  assert.equal(
    generationAuditReference("job_123", "attempt_123", "completed"),
    generationAuditReference("job_123", "attempt_123", "completed")
  );
  assert.equal(
    buildGeneratedOutputAssetId({ jobId: "job_123", attemptId: "attempt_123" }),
    buildGeneratedOutputAssetId({ jobId: "job_123", attemptId: "attempt_123" })
  );
});

test("generated development output draft is private and owner-scoped", () => {
  const draft = createGeneratedOutputAssetDraft({
    ownerId: "owner_123",
    jobId: "job_123",
    attemptId: "attempt_123",
    artifact: {
      contentType: "image/png",
      width: 512,
      height: 512,
      sizeBytes: 256,
      sha256: "b".repeat(64),
      storage: {
        bucket: "local-dev-generated-output",
        objectPath: "outputs/hash/job_123/attempt_123.png"
      },
      developmentOnly: true
    }
  });

  assert.equal(draft.ownerId, "owner_123");
  assert.equal(draft.generationJobId, "job_123");
  assert.equal(draft.kind, "GENERATED_OUTPUT");
  assert.equal(draft.isPrivate, true);
  assert.equal(draft.visibility, "PRIVATE");
  assert.equal(draft.metadata?.developmentOnly, true);
});

test("adapter registry exposes distinct Google AI Studio and GCP hosted adapters", async () => {
  const { getStepExecutionAdapterRegistration, listStepExecutionAdapters } = await loadInferenceAdapters();
  const googleAiStudio = getStepExecutionAdapterRegistration("google-ai-studio-image");
  const gcpHosted = getStepExecutionAdapterRegistration("gcp-hosted-gpu");

  assert.equal(googleAiStudio.credentialMode, "user-byok");
  assert.equal(gcpHosted.credentialMode, "platform-identity");
  assert.deepEqual(googleAiStudio.supportedRoutes, ["google-ai-studio-image"]);
  assert.deepEqual(gcpHosted.supportedRoutes, ["gcp-hosted-gpu"]);
  assert.equal(listStepExecutionAdapters().some((adapter) => adapter.id === "external-byok"), true);
});

test("adapter registry fails closed with safe configuration errors", async () => {
  const { assertStepExecutionAdapterConfigured, GenerationInferenceFailure } = await loadInferenceAdapters();
  const previousGpuUrl = process.env.GCP_GPU_EXECUTION_URL;
  const previousNodeEnv = process.env.NODE_ENV;
  const mutableEnv = process.env as Record<string, string | undefined>;

  delete process.env.GCP_GPU_EXECUTION_URL;
  assert.throws(
    () => assertStepExecutionAdapterConfigured("gcp-hosted-gpu"),
    (error) =>
      error instanceof GenerationInferenceFailure &&
      error.code === "GPU_RUNTIME_UNVERIFIED" &&
      !String(error.message).includes("http")
  );

  mutableEnv.NODE_ENV = "production";
  process.env.GCP_GPU_EXECUTION_URL = "https://private-ollama.run.app";
  assert.throws(
    () => assertStepExecutionAdapterConfigured("gcp-hosted-gpu"),
    (error) => error instanceof GenerationInferenceFailure && error.code === "GPU_RUNTIME_UNVERIFIED"
  );
  assert.throws(
    () => assertStepExecutionAdapterConfigured("development-fake"),
    (error) => error instanceof GenerationInferenceFailure && error.code === "DEVELOPMENT_FAKE_DISABLED"
  );

  if (previousGpuUrl === undefined) {
    delete process.env.GCP_GPU_EXECUTION_URL;
  } else {
    process.env.GCP_GPU_EXECUTION_URL = previousGpuUrl;
  }

  if (previousNodeEnv === undefined) {
    delete mutableEnv.NODE_ENV;
  } else {
    mutableEnv.NODE_ENV = previousNodeEnv;
  }
});

test("redaction removes sensitive values from worker-adjacent metadata", () => {
  const redacted = redactForLogging({
    authorization: "Bearer signed-token",
    nested: {
      apiKey: "secret-api-key",
      credential: "stored-secret",
      publicValue: "safe"
    }
  });

  assert.equal(redacted.authorization, "[REDACTED]");
  assert.equal(redacted.nested.apiKey, "[REDACTED]");
  assert.equal(redacted.nested.credential, "[REDACTED]");
  assert.equal(redacted.nested.publicValue, "safe");
});
