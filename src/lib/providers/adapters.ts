import type { WorkflowDocument } from "@/lib/workflow/schema";

export type ProviderKeyMode = "session-only" | "saved-encrypted";

export type ProviderCredentialSummary = {
  id: string;
  provider: string;
  mode: ProviderKeyMode;
  label: string;
  maskedSecret: string;
  createdAt: string;
  lastUsedAt?: string;
};

export type ProviderGenerationRequest = {
  userId: string;
  workflow: WorkflowDocument;
  credentialId?: string;
  idempotencyKey: string;
};

export type ProviderGenerationResult = {
  providerJobId: string;
  status: "queued" | "running" | "completed" | "failed";
  outputAssetIds: string[];
};

export type ProviderAdapter = {
  id: string;
  displayName: string;
  validateCredential(secret: string): Promise<{ ok: true } | { ok: false; reason: string }>;
  estimateCost(workflow: WorkflowDocument): Promise<{ credits: number; providerCostLabel: string }>;
  submitGeneration(request: ProviderGenerationRequest): Promise<ProviderGenerationResult>;
  cancelGeneration(providerJobId: string): Promise<void>;
};
