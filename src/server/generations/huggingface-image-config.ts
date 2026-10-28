import "server-only";
import crypto from "node:crypto";
import { huggingFaceCatalogueSha256 } from "@/lib/models/huggingface-image";

export class HuggingFaceImageError extends Error {
  constructor(readonly code: string, message: string, readonly retryable = false) {
    super(message);
    this.name = "HuggingFaceImageError";
  }
}
export type HuggingFaceConfiguration = { serviceUrl: string; audience: string; containerDigest: string; catalogueSha256: string };
export function huggingFaceDeploymentFingerprint(config: HuggingFaceConfiguration) {
  return crypto.createHash("sha256").update(JSON.stringify({ audience: config.audience, catalogueSha256: config.catalogueSha256, containerDigest: config.containerDigest, serviceUrl: config.serviceUrl })).digest("hex");
}
function assertAdmission(env: NodeJS.ProcessEnv) {
  if (env.HF_IMAGE_GENERATION_ENABLED !== "true" || env.HF_MODEL_CACHE_READY !== "true") {
    throw new HuggingFaceImageError("HF_SETUP_REQUIRED", "Prepare the Hugging Face model cache and enable the private L4 service.");
  }
  if (env.HF_MODEL_CATALOGUE_SHA256 !== huggingFaceCatalogueSha256 || !/^sha256:[a-f0-9]{64}$/.test(env.HF_CONTAINER_DIGEST ?? "") || !/^[a-f0-9]{64}$/.test(env.HF_DEPLOYMENT_FINGERPRINT ?? "")) {
    throw new HuggingFaceImageError("HF_CONFIG_INVALID", "The Hugging Face deployment must pin its container and reviewed model catalogue.");
  }
}
export function getHuggingFaceConfiguration(env: NodeJS.ProcessEnv = process.env): HuggingFaceConfiguration {
  assertAdmission(env);
  let url: URL;
  try { url = new URL(env.HF_SERVICE_URL ?? ""); }
  catch { throw new HuggingFaceImageError("HF_CONFIG_INVALID", "Configure the private Hugging Face Cloud Run origin."); }
  const audience = env.HF_AUDIENCE?.trim();
  if (url.protocol !== "https:" || !/^[a-z0-9-]+(?:\.[a-z0-9-]+)*\.run\.app$/.test(url.hostname) || url.port || url.username || url.password || url.pathname !== "/" || url.search || url.hash || !audience || audience.length > 2048 || audience === env.WORKER_AUDIENCE || audience === env.OLLAMA_AUDIENCE) {
    throw new HuggingFaceImageError("HF_CONFIG_INVALID", "Use a private HTTPS Cloud Run origin and a distinct Hugging Face ID-token audience.");
  }
  const config = { serviceUrl: url.origin, audience, containerDigest: env.HF_CONTAINER_DIGEST!, catalogueSha256: huggingFaceCatalogueSha256 };
  if (huggingFaceDeploymentFingerprint(config) !== env.HF_DEPLOYMENT_FINGERPRINT) throw new HuggingFaceImageError("HF_CONFIG_INVALID", "Hugging Face deployment fingerprint mismatch.");
  return config;
}
export function assertHuggingFaceConfigured(env: NodeJS.ProcessEnv = process.env) {
  assertAdmission(env);
  if (env.ASTRAFLOW_RUNTIME_ROLE !== "web") getHuggingFaceConfiguration(env);
}
export function huggingFaceSetupIssue(env: NodeJS.ProcessEnv = process.env) {
  try { assertHuggingFaceConfigured(env); return null; }
  catch (error) { return error instanceof HuggingFaceImageError ? `${error.code}: ${error.message}` : "HF_CONFIG_INVALID: Hugging Face configuration is unavailable."; }
}
