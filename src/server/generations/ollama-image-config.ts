import "server-only";
import crypto from "node:crypto";
import { ollamaImageModelDigest, unsupportedOllamaImageDigests } from "@/lib/models/ollama-image";

export class OllamaImageError extends Error {
  constructor(readonly code: string, message: string, readonly retryable = false) {
    super(message);
    this.name = "OllamaImageError";
  }
}

export type OllamaImageConfiguration = {
  serviceUrl: string;
  audience: string;
  containerDigest: string;
  modelDigest: string;
};

const digestPattern = /^sha256:[a-f0-9]{64}$/;
export function ollamaDeploymentFingerprint(config: OllamaImageConfiguration) {
  // Alphabetic keys match Terraform jsonencode; the web receives only this hash and pins.
  return crypto.createHash("sha256").update(JSON.stringify({
    audience: config.audience,
    containerDigest: config.containerDigest,
    modelDigest: config.modelDigest,
    serviceUrl: config.serviceUrl
  })).digest("hex");
}

export function assertOllamaImageAdmissionConfigured(env: NodeJS.ProcessEnv = process.env) {
  if (env.OLLAMA_IMAGE_GENERATION_ENABLED !== "true") {
    throw new OllamaImageError("GPU_RUNTIME_UNVERIFIED", "GPU inference is unavailable: no reviewed model runtime is enabled for Ollama image generation.");
  }
  if (!digestPattern.test(env.OLLAMA_CONTAINER_DIGEST ?? "") || !digestPattern.test(env.OLLAMA_MODEL_DIGEST ?? "") ||
      !/^[a-f0-9]{64}$/.test(env.OLLAMA_DEPLOYMENT_FINGERPRINT ?? "")) {
    throw new OllamaImageError("OLLAMA_CONFIG_REQUIRED", "Configure the immutable Ollama container/model digests and deployment fingerprint.");
  }
  if (unsupportedOllamaImageDigests.has(env.OLLAMA_CONTAINER_DIGEST!)) {
    throw new OllamaImageError("OLLAMA_IMAGE_RUNTIME_UNSUPPORTED", "The configured Ollama release rejects image generation. A compatible, live-verified runtime is required.");
  }
  if (env.OLLAMA_MODEL_DIGEST !== ollamaImageModelDigest || env.OLLAMA_MODEL_CACHE_READY !== "true") {
    throw new OllamaImageError("OLLAMA_MODEL_CACHE_REQUIRED", "Prepare and mount the verified FLUX.2 Klein 4B FP8 model cache before enabling inference.");
  }
}

export function getOllamaImageConfiguration(env: NodeJS.ProcessEnv = process.env): OllamaImageConfiguration {
  assertOllamaImageAdmissionConfigured(env);
  let url: URL;
  try { url = new URL(env.OLLAMA_SERVICE_URL ?? ""); }
  catch { throw new OllamaImageError("OLLAMA_CONFIG_REQUIRED", "Configure the private Ollama Cloud Run service URL."); }
  if (url.protocol !== "https:" || !/^[a-z0-9-]+(?:\.[a-z0-9-]+)*\.run\.app$/.test(url.hostname) ||
      url.port || url.username || url.password || url.pathname !== "/" || url.search || url.hash) {
    throw new OllamaImageError("OLLAMA_CONFIG_INVALID", "Ollama must use a private HTTPS Cloud Run service origin without credentials, paths or query parameters.");
  }
  const audience = env.OLLAMA_AUDIENCE?.trim();
  if (!audience || audience.length > 2048 || audience === env.WORKER_AUDIENCE) {
    throw new OllamaImageError("OLLAMA_CONFIG_INVALID", "Configure a distinct Ollama ID-token audience, separate from Cloud Tasks.");
  }
  const config = { serviceUrl: url.origin, audience, containerDigest: env.OLLAMA_CONTAINER_DIGEST!, modelDigest: env.OLLAMA_MODEL_DIGEST! };
  if (ollamaDeploymentFingerprint(config) !== env.OLLAMA_DEPLOYMENT_FINGERPRINT) {
    throw new OllamaImageError("OLLAMA_CONFIG_INVALID", "The Ollama deployment fingerprint does not match its URL, audience and immutable pins.");
  }
  return config;
}

export function assertOllamaImageConfigured(env: NodeJS.ProcessEnv = process.env) {
  assertOllamaImageAdmissionConfigured(env);
  // Web admission uses pins/fingerprint; only the actual caller receives the service URL/audience.
  if (env.ASTRAFLOW_RUNTIME_ROLE !== "web") getOllamaImageConfiguration(env);
}

export function ollamaImageSetupIssue(env: NodeJS.ProcessEnv = process.env) {
  try { assertOllamaImageConfigured(env); return null; }
  catch (error) { return error instanceof OllamaImageError ? `${error.code}: ${error.message}` : "OLLAMA_CONFIG_INVALID: Ollama configuration is unavailable."; }
}
