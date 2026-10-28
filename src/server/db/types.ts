import type { WorkflowDocument, WorkflowExecutionEnvironment } from "@/lib/workflow/schema";

export const collectionNames = {
  users: "users",
  sessions: "sessions",
  apiCredentials: "api_credentials",
  providers: "providers",
  models: "models",
  workflows: "workflows",
  workflowRevisions: "workflow_revisions",
  workflowShareLinks: "workflow_share_links",
  workflowEvents: "workflow_events",
  executionPlans: "execution_plans",
  generationJobs: "generation_jobs",
  assets: "assets",
  creditTransactions: "credit_transactions",
  auditEvents: "audit_events"
} as const;

export type CollectionName = (typeof collectionNames)[keyof typeof collectionNames];

export type UserRole = "STANDARD" | "PROFESSIONAL" | "ADMINISTRATOR" | "MODEL_MANAGER" | "SUSPENDED";
export type CredentialMode = "SESSION_ONLY" | "SAVED_ENCRYPTED";
export type ModelRoute =
  | "vertex-llm"
  | "vertex-image"
  | "google-ai-studio-image"
  | "gcp-hosted-gpu"
  | "huggingface-image"
  | "external-byok"
  | "development-fake"
  | "GCP_HOSTED"
  | "EXTERNAL_BYOK";
export type WorkflowStatus = "DRAFT" | "ACTIVE" | "ARCHIVED";
export type GenerationStatus =
  | "QUEUED"
  | "VALIDATING"
  | "STARTING"
  | "LOADING_MODEL"
  | "GENERATING"
  | "POST_PROCESSING"
  | "UPLOADING"
  | "PAUSED"
  | "COMPLETED"
  | "FAILED"
  | "CANCELLED"
  | "EXPIRED"
  | "MODERATION_BLOCKED";
export type AssetKind = "USER_UPLOAD" | "GENERATED_OUTPUT" | "THUMBNAIL" | "WORKFLOW_EXPORT";
export type AssetVisibility = "PRIVATE" | "UNLISTED_SHARE" | "PUBLIC_GALLERY";
export type AssetUploadState = "PENDING" | "COMPLETED" | "ABANDONED";
export type CreditTransactionKind = "PURCHASE" | "RESERVATION" | "CAPTURE" | "REFUND" | "ADMIN_ADJUSTMENT";
export type SessionRevocationReason = "LOGOUT" | "EXPIRED" | "ADMIN_REVOKED" | "ACCOUNT_DELETED" | "SUSPENDED";
export type GenerationAttemptStatus =
  | "CREATED"
  | "DISPATCHED"
  | "ACKNOWLEDGED"
  | "RETRYING"
  | "SUCCEEDED"
  | "FAILED"
  | "CANCELLED";
export type GenerationStepStatus = "PENDING" | "READY" | "RUNNING" | "COMPLETED" | "FAILED" | "SKIPPED" | "CANCELLED";

export type ExecutionPlanStep = {
  id: string;
  nodeId: string;
  nodeType: string;
  adapterId: string;
  modelId?: string;
  providerId?: string;
  route?: string;
  pinnedModelVersion?: string;
  inputPorts: Record<string, { sourceStepId?: string; sourceNodeId?: string; sourcePort?: string; type: string; value?: unknown }>;
  outputPorts: Record<string, { type: string; artifactRole?: "intermediate" | "final" }>;
  parameters: Record<string, unknown>;
  dependencies: string[];
  retryPolicy: {
    maxAttempts: number;
    backoffSeconds: number;
    retryable: boolean;
  };
  timeoutSeconds: number;
  optional: boolean;
  estimates: {
    credits: number;
    timeoutSeconds: number;
    pixels?: number;
    steps?: number;
    batch?: number;
  };
  outputObjectPrefix: string;
};

export type ExecutionPlanDocument = {
  _id: string;
  ownerId: string;
  workflowId: string;
  workflowRevisionId: string;
  version: number;
  planHash: string;
  workflowSchemaVersion: number;
  compilerVersion: string;
  executionEnvironment: WorkflowExecutionEnvironment;
  steps: ExecutionPlanStep[];
  routeSummary: string[];
  modelIds: string[];
  assetIds: string[];
  estimates: {
    credits: number;
    timeoutSeconds: number;
    maxPixels: number;
  };
  createdAt: Date;
};

export type UserDocument = {
  _id: string;
  provider: "google";
  providerUserId: string;
  email?: string;
  displayName?: string;
  picture?: string;
  role: UserRole;
  isSuspended: boolean;
  createdAt: Date;
  updatedAt: Date;
  deletedAt?: Date;
};

export type SessionDocument = {
  _id: string;
  userId: string;
  tokenHash: string;
  ipHash?: string;
  userAgent?: string;
  createdAt: Date;
  lastSeenAt: Date;
  expiresAt: Date;
  revokedAt?: Date;
  revocationReason?: SessionRevocationReason;
};

export type ApiCredentialDocument = {
  _id: string;
  userId: string;
  provider: string;
  label: string;
  mode: CredentialMode;
  encryptedSecret?: Buffer;
  wrappedDataKey?: Buffer;
  kmsKeyVersion?: string;
  maskedSecret: string;
  createdAt: Date;
  lastUsedAt?: Date;
  deletedAt?: Date;
};

export type ProviderDocument = {
  _id: string;
  name: string;
  route: ModelRoute;
  isEnabled: boolean;
  credentialSchema?: unknown;
  createdAt: Date;
  updatedAt: Date;
};

export type ModelRecordDocument = {
  _id: string;
  providerId: string;
  displayName: string;
  family: string;
  route: ModelRoute;
  licence: string;
  licenceStatus: string;
  capabilities: unknown;
  maxPixels: number;
  maxSteps: number;
  baseCreditCost: number;
  isEnabled: boolean;
  pinnedVersion?: string;
  adapterConfig?: Record<string, unknown>;
  verification?: import("@/server/models/policy").ModelVerification;
  createdAt: Date;
  updatedAt: Date;
};

export type WorkflowDocumentRecord = {
  _id: string;
  ownerId: string;
  folderId?: string;
  name: string;
  status: WorkflowStatus;
  currentRevisionId?: string;
  revision: number;
  createdAt: Date;
  updatedAt: Date;
  archivedAt?: Date;
};

export type WorkflowRevisionDocument = {
  _id: string;
  workflowId: string;
  ownerId: string;
  revision: number;
  workflow: WorkflowDocument;
  selectedModel: string;
  workflowSchemaVersion?: number;
  validation: {
    ok: true;
    warnings: string[];
  };
  createdAt: Date;
};

export type WorkflowShareLinkDocument = {
  _id: string;
  workflowId: string;
  ownerId: string;
  tokenHash: string;
  role: "viewer" | "editor";
  createdAt: Date;
  expiresAt?: Date;
  revokedAt?: Date;
};

export type WorkflowEventDocument = {
  _id: string;
  workflowId: string;
  ownerId: string;
  actorUserId?: string;
  eventType: string;
  revision?: number;
  metadata?: Record<string, unknown>;
  createdAt: Date;
};

export type GenerationAttemptDocument = {
  id: string;
  attemptNumber: number;
  taskName?: string;
  status: GenerationAttemptStatus;
  dispatchedAt?: Date;
  acknowledgedAt?: Date;
  leaseExpiresAt?: Date;
  completedAt?: Date;
  errorCode?: string;
  errorMessage?: string;
  metadata?: Record<string, unknown>;
};

export type GenerationStepAttemptDocument = {
  id: string;
  attemptNumber: number;
  status: GenerationAttemptStatus;
  adapterId: string;
  leaseExpiresAt?: Date;
  startedAt?: Date;
  completedAt?: Date;
  errorCode?: string;
  errorMessage?: string;
  idempotencyKey: string;
};

export type GenerationStepDocument = {
  id: string;
  nodeId: string;
  nodeType: string;
  status: GenerationStepStatus;
  progress: number;
  adapterId: string;
  modelId?: string;
  providerId?: string;
  route?: string;
  attemptNumber: number;
  leaseExpiresAt?: Date;
  startedAt?: Date;
  completedAt?: Date;
  errorCode?: string;
  errorMessage?: string;
  inputArtifactIds?: string[];
  outputArtifactIds?: string[];
  outputs?: Record<string, unknown>;
  usage?: Record<string, unknown>;
  idempotencyKey: string;
  attempts: GenerationStepAttemptDocument[];
};

export type GenerationJobEventDocument = {
  id: string;
  status: GenerationStatus;
  progress: number;
  message?: string;
  metadata?: Record<string, unknown>;
  createdAt: Date;
};

export type GenerationJobDocument = {
  verificationModelId?: string;
  _id: string;
  ownerId: string;
  workflowId?: string;
  workflowRevisionId: string;
  executionPlanId?: string;
  executionPlanVersion?: number;
  executionPlanHash?: string;
  modelId?: string;
  modelIds?: string[];
  executionEnvironment?: WorkflowExecutionEnvironment;
  routeSummary?: string[];
  idempotencyKey: string;
  status: GenerationStatus;
  progress: number;
  estimatedCredits: number;
  reservedCredits?: number;
  unlimitedDevelopment?: boolean;
  providerJobId?: string;
  errorCode?: string;
  errorMessage?: string;
  steps?: GenerationStepDocument[];
  attempts: GenerationAttemptDocument[];
  events: GenerationJobEventDocument[];
  createdAt: Date;
  startedAt?: Date;
  completedAt?: Date;
};

export type AssetDocument = {
  _id: string;
  ownerId: string;
  generationJobId?: string;
  kind: AssetKind;
  bucket: string;
  objectPath: string;
  contentType: string;
  width?: number;
  height?: number;
  sizeBytes?: number;
  sha256?: string;
  isPrivate: boolean;
  visibility: AssetVisibility;
  uploadState?: AssetUploadState;
  shareTokenHash?: string;
  metadata?: Record<string, unknown>;
  expiresAt?: Date;
  createdAt: Date;
  uploadCompletedAt?: Date;
  deletedAt?: Date;
};

export type CreditTransactionDocument = {
  _id: string;
  userId: string;
  kind: CreditTransactionKind;
  amount: number;
  referenceId?: string;
  metadata?: Record<string, unknown>;
  createdAt: Date;
};

export type AuditEventDocument = {
  _id: string;
  userId?: string;
  actorUserId?: string;
  eventType: string;
  targetType: string;
  targetId?: string;
  referenceId?: string;
  ipHash?: string;
  userAgent?: string;
  metadata?: Record<string, unknown>;
  createdAt: Date;
};
