import "server-only";
import crypto from "node:crypto";
import { getModelById, type ModelDefinition } from "@/lib/models/catalog";
import { configurationRequired, notFound } from "@/server/errors";
import type { ModelRecordDocument, ProviderDocument } from "@/server/db/types";

export type ModelVerification = { catalogueRevision: string; adapterRevision: string; configurationFingerprint: string; verifiedAt: Date; jobId: string; assetId: string; sha256: string; operations: string[] };
export function modelConfigurationFingerprint(model: ModelDefinition, env = process.env) {
  return crypto.createHash("sha256").update(JSON.stringify({ route: model.route, project: env.GCP_PROJECT_ID, location: env.VERTEX_AI_LOCATION, output: env.GCS_OUTPUT_BUCKET, kms: env.KMS_KEY_RESOURCE, audience: env.WORKER_AUDIENCE, invoker: env.WORKER_INVOKER_SERVICE_ACCOUNT_EMAIL,
    ...(model.route === "gcp-hosted-gpu" ? { ollamaDeployment: env.OLLAMA_DEPLOYMENT_FINGERPRINT } : {}),
    ...(model.route === "huggingface-image" ? { huggingFaceDeployment: env.HF_DEPLOYMENT_FINGERPRINT } : {})
  })).digest("hex");
}
export function supportedModelDefinition(record: ModelRecordDocument, provider: ProviderDocument) {
  const definition = getModelById(record._id);
  if (!definition || record.providerId !== definition.providerId || record.route !== definition.route || provider._id !== definition.providerId || provider.route !== definition.route || record.pinnedVersion !== definition.providerModelId) throw notFound("This model record is unknown, stale or incompatible with its reviewed adapter. Run the catalogue migration; arbitrary models and providers are unavailable.");
  if (definition.developmentOnly && process.env.NODE_ENV === "production") throw notFound("Development placeholders are unavailable in production.");
  if (definition.retirementDate && new Date() >= new Date(definition.retirementDate)) throw notFound("This provider model has reached its documented retirement date.");
  return definition;
}
export function modelVerificationIssue(record: ModelRecordDocument, definition: ModelDefinition) {
  if (definition.developmentOnly) return null;
  const evidence = record.verification;
  const age = evidence ? Date.now() - new Date(evidence.verifiedAt).getTime() : Infinity;
  if (!evidence || !Number.isFinite(age) || age < 0 || age > 30 * 24 * 60 * 60 * 1000 || evidence.catalogueRevision !== definition.catalogueRevision || evidence.adapterRevision !== definition.adapterRevision || evidence.configurationFingerprint !== modelConfigurationFingerprint(definition) || !evidence.assetId || !/^[a-f0-9]{64}$/.test(evidence.sha256) || !definition.capabilities.every((operation) => evidence.operations.includes(operation))) return "Unavailable: this deployment has no current live inference-to-private-storage verification for this model. An operator must run npm run verify:model:live before enabling it.";
  return null;
}
export function assertModelLiveVerified(record: ModelRecordDocument, definition: ModelDefinition) {
  const issue = modelVerificationIssue(record, definition);
  if (issue) throw configurationRequired(issue);
}
