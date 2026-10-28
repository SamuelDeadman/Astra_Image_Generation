import "server-only";

import type { Db, Document } from "mongodb";
import { getMongoDb } from "@/server/db/mongodb";
import {
  collectionNames,
  type ApiCredentialDocument,
  type AssetDocument,
  type AuditEventDocument,
  type CreditTransactionDocument,
  type ExecutionPlanDocument,
  type GenerationJobDocument,
  type ModelRecordDocument,
  type ProviderDocument,
  type SessionDocument,
  type UserDocument,
  type WorkflowDocumentRecord,
  type WorkflowEventDocument,
  type WorkflowRevisionDocument,
  type WorkflowShareLinkDocument
} from "@/server/db/types";

type JsonSchemaPropertyMap = Record<string, Document>;

function objectValidator(required: string[], properties: JsonSchemaPropertyMap): Document {
  return {
    $jsonSchema: {
      bsonType: "object",
      required,
      properties
    }
  };
}

const dateProperty = { bsonType: "date" } as const;
const stringProperty = { bsonType: "string" } as const;
const boolProperty = { bsonType: "bool" } as const;
const intProperty = { bsonType: "int" } as const;
const numberProperty = { bsonType: ["int", "long", "double", "decimal"] } as const;
const objectProperty = { bsonType: "object" } as const;
const modelRouteProperty = {
  enum: [
    "vertex-llm",
    "vertex-image",
    "google-ai-studio-image",
    "gcp-hosted-gpu",
    "huggingface-image",
    "external-byok",
    "development-fake",
    "GCP_HOSTED",
    "EXTERNAL_BYOK"
  ]
} as const;
const executionEnvironmentProperty = {
  enum: ["gcp-hosted", "huggingface-l4", "google-ai-studio", "external-byok", "development-local"]
} as const;

const collectionValidators = {
  [collectionNames.users]: objectValidator(["_id", "provider", "providerUserId", "role", "isSuspended", "createdAt", "updatedAt"], {
    _id: stringProperty,
    provider: { enum: ["google"] },
    providerUserId: stringProperty,
    email: stringProperty,
    displayName: stringProperty,
    picture: stringProperty,
    role: { enum: ["STANDARD", "PROFESSIONAL", "ADMINISTRATOR", "MODEL_MANAGER", "SUSPENDED"] },
    isSuspended: boolProperty,
    createdAt: dateProperty,
    updatedAt: dateProperty,
    deletedAt: dateProperty
  }),
  [collectionNames.sessions]: objectValidator(["_id", "userId", "tokenHash", "createdAt", "lastSeenAt", "expiresAt"], {
    _id: stringProperty,
    userId: stringProperty,
    tokenHash: stringProperty,
    ipHash: stringProperty,
    userAgent: stringProperty,
    createdAt: dateProperty,
    lastSeenAt: dateProperty,
    expiresAt: dateProperty,
    revokedAt: dateProperty,
    revocationReason: { enum: ["LOGOUT", "EXPIRED", "ADMIN_REVOKED", "ACCOUNT_DELETED", "SUSPENDED"] }
  }),
  [collectionNames.apiCredentials]: objectValidator(
    ["_id", "userId", "provider", "label", "mode", "maskedSecret", "createdAt"],
    {
      _id: stringProperty,
      userId: stringProperty,
      provider: stringProperty,
      label: stringProperty,
      mode: { enum: ["SESSION_ONLY", "SAVED_ENCRYPTED"] },
      encryptedSecret: { bsonType: "binData" },
      wrappedDataKey: { bsonType: "binData" },
      kmsKeyVersion: stringProperty,
      maskedSecret: stringProperty,
      createdAt: dateProperty,
      lastUsedAt: dateProperty,
      deletedAt: dateProperty
    }
  ),
  [collectionNames.providers]: objectValidator(["_id", "name", "route", "isEnabled", "createdAt", "updatedAt"], {
    _id: stringProperty,
    name: stringProperty,
    route: modelRouteProperty,
    isEnabled: boolProperty,
    credentialSchema: objectProperty,
    createdAt: dateProperty,
    updatedAt: dateProperty
  }),
  [collectionNames.models]: objectValidator(
    [
      "_id",
      "providerId",
      "displayName",
      "family",
      "route",
      "licence",
      "licenceStatus",
      "capabilities",
      "maxPixels",
      "maxSteps",
      "baseCreditCost",
      "isEnabled",
      "createdAt",
      "updatedAt"
    ],
    {
      _id: stringProperty,
      providerId: stringProperty,
      displayName: stringProperty,
      family: stringProperty,
      route: modelRouteProperty,
      licence: stringProperty,
      licenceStatus: stringProperty,
      capabilities: { bsonType: ["array", "object"] },
      maxPixels: intProperty,
      maxSteps: intProperty,
      baseCreditCost: intProperty,
      isEnabled: boolProperty,
      pinnedVersion: stringProperty,
      adapterConfig: objectProperty,
      verification: objectProperty,
      catalogueRevision: stringProperty,
      createdAt: dateProperty,
      updatedAt: dateProperty
    }
  ),
  [collectionNames.workflows]: objectValidator(
    ["_id", "ownerId", "name", "status", "revision", "createdAt", "updatedAt"],
    {
      _id: stringProperty,
      ownerId: stringProperty,
      folderId: stringProperty,
      name: stringProperty,
      status: { enum: ["DRAFT", "ACTIVE", "ARCHIVED"] },
      currentRevisionId: stringProperty,
      revision: intProperty,
      createdAt: dateProperty,
      updatedAt: dateProperty,
      archivedAt: dateProperty
    }
  ),
  [collectionNames.workflowRevisions]: objectValidator(
    ["_id", "workflowId", "ownerId", "revision", "workflow", "selectedModel", "validation", "createdAt"],
    {
      _id: stringProperty,
      workflowId: stringProperty,
      ownerId: stringProperty,
      revision: intProperty,
      workflow: objectProperty,
      selectedModel: stringProperty,
      workflowSchemaVersion: intProperty,
      validation: objectProperty,
      createdAt: dateProperty
    }
  ),
  [collectionNames.executionPlans]: objectValidator(
    [
      "_id",
      "ownerId",
      "workflowId",
      "workflowRevisionId",
      "version",
      "planHash",
      "workflowSchemaVersion",
      "compilerVersion",
      "executionEnvironment",
      "steps",
      "routeSummary",
      "modelIds",
      "assetIds",
      "estimates",
      "createdAt"
    ],
    {
      _id: stringProperty,
      ownerId: stringProperty,
      workflowId: stringProperty,
      workflowRevisionId: stringProperty,
      version: intProperty,
      planHash: stringProperty,
      workflowSchemaVersion: intProperty,
      compilerVersion: stringProperty,
      executionEnvironment: executionEnvironmentProperty,
      steps: { bsonType: "array" },
      routeSummary: { bsonType: "array" },
      modelIds: { bsonType: "array" },
      assetIds: { bsonType: "array" },
      estimates: objectProperty,
      createdAt: dateProperty
    }
  ),
  [collectionNames.workflowShareLinks]: objectValidator(
    ["_id", "workflowId", "ownerId", "tokenHash", "role", "createdAt"],
    {
      _id: stringProperty,
      workflowId: stringProperty,
      ownerId: stringProperty,
      tokenHash: stringProperty,
      role: { enum: ["viewer", "editor"] },
      createdAt: dateProperty,
      expiresAt: dateProperty,
      revokedAt: dateProperty
    }
  ),
  [collectionNames.workflowEvents]: objectValidator(["_id", "workflowId", "ownerId", "eventType", "createdAt"], {
    _id: stringProperty,
    workflowId: stringProperty,
    ownerId: stringProperty,
    actorUserId: stringProperty,
    eventType: stringProperty,
    revision: intProperty,
    metadata: objectProperty,
    createdAt: dateProperty
  }),
  [collectionNames.generationJobs]: objectValidator(
    [
      "_id",
      "ownerId",
      "workflowRevisionId",
      "executionPlanId",
      "executionPlanVersion",
      "executionPlanHash",
      "idempotencyKey",
      "status",
      "progress",
      "estimatedCredits",
      "steps",
      "attempts",
      "events",
      "createdAt"
    ],
    {
      _id: stringProperty,
      ownerId: stringProperty,
      verificationModelId: stringProperty,
      workflowId: stringProperty,
      workflowRevisionId: stringProperty,
      executionPlanId: stringProperty,
      executionPlanVersion: intProperty,
      executionPlanHash: stringProperty,
      modelId: stringProperty,
      modelIds: { bsonType: "array" },
      executionEnvironment: executionEnvironmentProperty,
      routeSummary: { bsonType: "array" },
      idempotencyKey: stringProperty,
      status: {
        enum: [
          "QUEUED",
          "VALIDATING",
          "STARTING",
          "LOADING_MODEL",
          "GENERATING",
          "POST_PROCESSING",
          "UPLOADING",
          "PAUSED",
          "COMPLETED",
          "FAILED",
          "CANCELLED",
          "EXPIRED",
          "MODERATION_BLOCKED"
        ]
      },
      progress: intProperty,
      estimatedCredits: intProperty,
      reservedCredits: intProperty,
      unlimitedDevelopment: boolProperty,
      providerJobId: stringProperty,
      errorCode: stringProperty,
      errorMessage: stringProperty,
      steps: { bsonType: "array" },
      attempts: { bsonType: "array" },
      events: { bsonType: "array" },
      createdAt: dateProperty,
      startedAt: dateProperty,
      completedAt: dateProperty
    }
  ),
  [collectionNames.assets]: objectValidator(
    ["_id", "ownerId", "kind", "bucket", "objectPath", "contentType", "isPrivate", "visibility", "createdAt"],
    {
      _id: stringProperty,
      ownerId: stringProperty,
      generationJobId: stringProperty,
      kind: { enum: ["USER_UPLOAD", "GENERATED_OUTPUT", "THUMBNAIL", "WORKFLOW_EXPORT"] },
      bucket: stringProperty,
      objectPath: stringProperty,
      contentType: stringProperty,
      width: intProperty,
      height: intProperty,
      sizeBytes: numberProperty,
      sha256: stringProperty,
      isPrivate: boolProperty,
      visibility: { enum: ["PRIVATE", "UNLISTED_SHARE", "PUBLIC_GALLERY"] },
      uploadState: { enum: ["PENDING", "COMPLETED", "ABANDONED"] },
      shareTokenHash: stringProperty,
      metadata: objectProperty,
      expiresAt: dateProperty,
      createdAt: dateProperty,
      uploadCompletedAt: dateProperty,
      deletedAt: dateProperty
    }
  ),
  [collectionNames.creditTransactions]: objectValidator(["_id", "userId", "kind", "amount", "createdAt"], {
    _id: stringProperty,
    userId: stringProperty,
    kind: { enum: ["PURCHASE", "RESERVATION", "CAPTURE", "REFUND", "ADMIN_ADJUSTMENT"] },
    amount: intProperty,
    referenceId: stringProperty,
    metadata: objectProperty,
    createdAt: dateProperty
  }),
  [collectionNames.auditEvents]: objectValidator(["_id", "eventType", "targetType", "createdAt"], {
    _id: stringProperty,
    userId: stringProperty,
    actorUserId: stringProperty,
    eventType: stringProperty,
    targetType: stringProperty,
    targetId: stringProperty,
    referenceId: stringProperty,
    ipHash: stringProperty,
    userAgent: stringProperty,
    metadata: objectProperty,
    createdAt: dateProperty
  })
} satisfies Record<string, Document>;

export const requiredCollectionNames = Object.values(collectionNames);

async function ensureCollection(db: Db, name: string, validator: Document, existingNames: Set<string>) {
  if (!existingNames.has(name)) {
    await db.createCollection(name, {
      validator,
      validationAction: "error",
      validationLevel: "moderate"
    });
    existingNames.add(name);
    return;
  }

  await db.command({
    collMod: name,
    validator,
    validationAction: "error",
    validationLevel: "moderate"
  });
}

async function ensureIndexes(db: Db) {
  await Promise.all([
    db.collection<UserDocument>(collectionNames.users).createIndexes([
      { key: { provider: 1, providerUserId: 1 }, unique: true, name: "users_provider_subject_unique" },
      { key: { email: 1 }, name: "users_email_lookup", sparse: true },
      { key: { deletedAt: 1 }, name: "users_deletedAt_lookup", sparse: true }
    ]),
    db.collection<SessionDocument>(collectionNames.sessions).createIndexes([
      { key: { tokenHash: 1 }, unique: true, name: "sessions_tokenHash_unique" },
      { key: { userId: 1, expiresAt: 1 }, name: "sessions_user_expiry" },
      { key: { expiresAt: 1 }, expireAfterSeconds: 0, name: "sessions_expiry_ttl" }
    ]),
    db.collection<ApiCredentialDocument>(collectionNames.apiCredentials).createIndexes([
      { key: { userId: 1, provider: 1, deletedAt: 1 }, name: "api_credentials_user_provider_active" },
      { key: { deletedAt: 1 }, name: "api_credentials_deletedAt_lookup", sparse: true }
    ]),
    db.collection<ProviderDocument>(collectionNames.providers).createIndexes([
      { key: { route: 1, isEnabled: 1 }, name: "providers_route_enabled" },
      { key: { name: 1 }, name: "providers_name_sort" }
    ]),
    db.collection<ModelRecordDocument>(collectionNames.models).createIndexes([
      { key: { providerId: 1, isEnabled: 1 }, name: "models_provider_enabled" },
      { key: { route: 1, isEnabled: 1, displayName: 1 }, name: "models_route_enabled_sort" }
    ]),
    db.collection<WorkflowDocumentRecord>(collectionNames.workflows).createIndexes([
      { key: { ownerId: 1, folderId: 1, status: 1, updatedAt: -1 }, name: "workflows_owner_folder_status" },
      { key: { ownerId: 1, archivedAt: 1, updatedAt: -1 }, name: "workflows_owner_active_sort" },
      { key: { currentRevisionId: 1 }, name: "workflows_current_revision", sparse: true }
    ]),
    db.collection<WorkflowRevisionDocument>(collectionNames.workflowRevisions).createIndexes([
      { key: { workflowId: 1, revision: 1 }, unique: true, name: "workflow_revisions_workflow_revision_unique" },
      { key: { ownerId: 1, createdAt: -1 }, name: "workflow_revisions_owner_history" }
    ]),
    db.collection<ExecutionPlanDocument>(collectionNames.executionPlans).createIndexes([
      { key: { workflowRevisionId: 1, planHash: 1 }, unique: true, name: "execution_plans_revision_hash_unique" },
      { key: { ownerId: 1, createdAt: -1 }, name: "execution_plans_owner_history" }
    ]),
    db.collection<WorkflowShareLinkDocument>(collectionNames.workflowShareLinks).createIndexes([
      { key: { tokenHash: 1 }, unique: true, name: "workflow_share_links_token_unique" },
      { key: { workflowId: 1, revokedAt: 1 }, name: "workflow_share_links_workflow_active" },
      { key: { expiresAt: 1 }, expireAfterSeconds: 0, name: "workflow_share_links_expiry_ttl" }
    ]),
    db.collection<WorkflowEventDocument>(collectionNames.workflowEvents).createIndexes([
      { key: { workflowId: 1, createdAt: -1 }, name: "workflow_events_workflow_history" },
      { key: { ownerId: 1, createdAt: -1 }, name: "workflow_events_owner_history" }
    ]),
    db.collection<GenerationJobDocument>(collectionNames.generationJobs).createIndexes([
      { key: { ownerId: 1, idempotencyKey: 1 }, unique: true, name: "generation_jobs_owner_idempotency_unique" },
      { key: { ownerId: 1, status: 1, createdAt: -1 }, name: "generation_jobs_owner_status_sort" },
      { key: { workflowRevisionId: 1 }, name: "generation_jobs_workflow_revision" },
      { key: { executionPlanId: 1 }, name: "generation_jobs_execution_plan", sparse: true },
      { key: { "steps.status": 1, "steps.leaseExpiresAt": 1 }, name: "generation_jobs_step_recovery", sparse: true }
    ]),
    db.collection<AssetDocument>(collectionNames.assets).createIndexes([
      { key: { ownerId: 1, kind: 1, createdAt: -1 }, name: "assets_owner_kind_sort" },
      { key: { generationJobId: 1, createdAt: 1 }, name: "assets_generation_job" },
      { key: { bucket: 1, objectPath: 1 }, unique: true, name: "assets_storage_object_unique" },
      { key: { visibility: 1, createdAt: -1 }, name: "assets_visibility_sort" }
    ]),
    db.collection<CreditTransactionDocument>(collectionNames.creditTransactions).createIndexes([
      { key: { userId: 1, createdAt: -1 }, name: "credit_transactions_user_history" },
      { key: { referenceId: 1 }, unique: true, name: "credit_transactions_reference_unique", sparse: true }
    ]),
    db.collection<AuditEventDocument>(collectionNames.auditEvents).createIndexes([
      { key: { eventType: 1, createdAt: -1 }, name: "audit_events_type_time" },
      { key: { userId: 1, createdAt: -1 }, name: "audit_events_user_time", sparse: true },
      { key: { targetType: 1, targetId: 1, createdAt: -1 }, name: "audit_events_target_time", sparse: true },
      { key: { referenceId: 1 }, unique: true, name: "audit_events_reference_unique", sparse: true }
    ])
  ]);
}

export async function ensureMongoFoundation() {
  const db = await getMongoDb();
  const existingCollections = await db.listCollections({}, { nameOnly: true }).toArray();
  const existingNames = new Set(existingCollections.map((collection) => collection.name));

  for (const [name, validator] of Object.entries(collectionValidators)) {
    await ensureCollection(db, name, validator, existingNames);
  }

  await ensureIndexes(db);
}

export async function inspectMongoFoundation() {
  const db = await getMongoDb();
  const existing = await db.listCollections({}, { nameOnly: true }).toArray();
  const existingNames = new Set(existing.map((collection) => collection.name));

  return {
    required: requiredCollectionNames,
    missing: requiredCollectionNames.filter((name) => !existingNames.has(name))
  };
}
