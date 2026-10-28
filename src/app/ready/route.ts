import { NextResponse } from "next/server";
import { checkMongoReady, expectedMongoDatabaseName } from "@/server/db/mongodb";
import { ensureMongoFoundation, inspectMongoFoundation } from "@/server/db/schema";
import {
  assertDevelopmentUnlimitedBalanceGuard,
  isDevelopmentUnlimitedBalanceEnabled
} from "@/server/entitlements/development";
import { missingEnv, optionalEnv } from "@/server/env";
import { isLocalGenerationWorkerEnabled, missingLocalGenerationWorkerEnv } from "@/server/generations/worker-config";
import { googleClientIdIssue } from "@/lib/auth/configuration";
import { listEnabledModels } from "@/server/models/models";
import { mongoFailure, safeErrorMetadata, safeMongoServerMessage } from "@/server/db/failures";

export const runtime = "nodejs";

export async function GET() {
  const dependencyStatus: Record<string, unknown> = {};
  let databaseReachable = false;
  const workerRuntime = optionalEnv("ASTRAFLOW_RUNTIME_ROLE") === "worker";
  const authIssue = googleClientIdIssue(process.env.GOOGLE_CLIENT_ID);
  dependencyStatus.authentication = workerRuntime ? { status: "configured", mode: "private-worker-oidc" } : authIssue ? { status: "not-configured", reason: authIssue } : { status: "configured", hint: "Verify this site's exact origin in Google Console Authorized JavaScript origins; production cookies require HTTPS." };

  try {
    const mongo = await checkMongoReady();
    databaseReachable = true;
    dependencyStatus.database =
      process.env.NODE_ENV === "production" || mongo.dbName === expectedMongoDatabaseName
        ? { status: "ready", database: mongo.dbName }
        : {
            status: "not-ready",
            database: mongo.dbName,
            reason: `MONGODB_DB_NAME must be ${expectedMongoDatabaseName}.`
          };
  } catch (error) {
    console.error("Readiness database check failed", safeErrorMetadata(error));
    dependencyStatus.database = {
      status: "not-ready",
      reason: mongoFailure(error)?.message ?? "Database check failed. Check MONGODB_URI and MONGODB_DB_NAME."
    };
  }

  if (databaseReachable && optionalEnv("MONGODB_AUTO_ENSURE_INDEXES") === "true") {
    try {
      await ensureMongoFoundation();
      const foundation = await inspectMongoFoundation();
      dependencyStatus.mongoSchema =
        foundation.missing.length === 0
          ? { status: "configured", collections: foundation.required.length }
          : { status: "not-configured", missing: foundation.missing };
    } catch (error) {
      console.error("MongoDB schema setup failed", {
        operation: "ensure-foundation",
        ...safeErrorMetadata(error),
        message: safeMongoServerMessage(error)
      });
      dependencyStatus.mongoSchema = {
        status: "not-configured",
        reason: mongoFailure(error)?.message ?? "MongoDB schema/index setup failed. Check database setup permissions."
      };
    }
  } else if (databaseReachable) {
    try {
      const foundation = await inspectMongoFoundation();
      dependencyStatus.mongoSchema =
        foundation.missing.length === 0
          ? { status: "configured", collections: foundation.required.length }
          : {
              status: "not-configured",
              missing: foundation.missing,
              hint: "Set MONGODB_AUTO_ENSURE_INDEXES=true during controlled setup to create validators and indexes."
            };
    } catch (error) {
            console.error("MongoDB schema inspection failed", {
              operation: "inspect-foundation",
              ...safeErrorMetadata(error),
              message: safeMongoServerMessage(error)
            });
            dependencyStatus.mongoSchema = {
              status: "not-configured",
              reason: mongoFailure(error)?.message ?? "MongoDB schema/index inspection failed. Check database permissions."
      };
    }
  } else {
    dependencyStatus.mongoSchema = "not-checked";
  }

  if (databaseReachable) {
    try {
      const models = await listEnabledModels();
      dependencyStatus.modelCatalogue = models.length ? { status: "configured", enabledModels: models.length } : { status: "not-configured", reason: "No enabled model/provider pairs. Run npm run seed:dev after controlled /ready schema setup." };
      dependencyStatus.inference = models.some((model) => !model.generationUnavailableReason) ? { status: "configured", hint: "Configuration detected only; verify real image generation and cloud permissions end to end." } : { status: "not-configured", reasons: [...new Set(models.map((model) => model.generationUnavailableReason).filter(Boolean))] };
    } catch (error) {
      dependencyStatus.modelCatalogue = { status: "not-configured", reason: mongoFailure(error)?.message ?? "Model catalogue check failed." };
    }
  } else dependencyStatus.modelCatalogue = "not-checked";

  const storageMissing = missingEnv(["GCS_INPUT_BUCKET", "GCS_OUTPUT_BUCKET"]);
  dependencyStatus.storage =
    storageMissing.length === 0 ? "configured" : { status: "not-configured", missing: storageMissing };

  if (workerRuntime) {
    const missing = missingEnv(["WORKER_INVOKER_SERVICE_ACCOUNT_EMAIL", "WORKER_AUDIENCE"]);
    dependencyStatus.queue = missing.length ? { status: "not-configured", missing } : { status: "configured", mode: "private-worker-oidc" };
  } else if (isLocalGenerationWorkerEnabled()) {
    const localWorkerMissing = missingLocalGenerationWorkerEnv();
    dependencyStatus.queue =
      localWorkerMissing.length === 0
        ? { status: "configured", mode: "local-development-worker" }
        : { status: "not-configured", mode: "local-development-worker", missing: localWorkerMissing };
  } else {
    const queueMissing = missingEnv([
      "GCP_PROJECT_ID",
      "GCP_TASKS_LOCATION",
      "GCP_TASKS_QUEUE",
      "GENERATION_WORKER_URL",
      "WORKER_INVOKER_SERVICE_ACCOUNT_EMAIL",
      "WORKER_AUDIENCE"
    ]);
    dependencyStatus.queue =
      queueMissing.length === 0 ? "configured" : { status: "not-configured", missing: queueMissing };
  }

  const kmsMissing = missingEnv(["KMS_KEY_RESOURCE"]);
  dependencyStatus.kms = kmsMissing.length === 0 ? "configured" : { status: "not-configured", missing: kmsMissing };

  try {
    assertDevelopmentUnlimitedBalanceGuard();
    dependencyStatus.entitlements = isDevelopmentUnlimitedBalanceEnabled()
      ? { status: "configured", mode: "development-unlimited" }
      : { status: "configured", mode: "metered" };
  } catch (error) {
    dependencyStatus.entitlements = {
      status: "not-configured",
      reason: error instanceof Error ? error.message : "Entitlement guard failed."
    };
  }

  const ok = Object.values(dependencyStatus).every(
    (value) =>
      value === "ready" ||
      value === "configured" ||
      (typeof value === "object" &&
        value !== null &&
        "status" in value &&
        (value as { status?: unknown }).status === "ready") ||
      (typeof value === "object" &&
        value !== null &&
        "status" in value &&
        (value as { status?: unknown }).status === "configured")
  );

  return NextResponse.json({ ok, dependencies: dependencyStatus }, { status: ok ? 200 : 503 });
}
