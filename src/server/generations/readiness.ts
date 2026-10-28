import type { ProviderRoute } from "@/lib/workflow/schema";
import { isLocalGenerationWorkerEnabled, missingLocalGenerationWorkerEnv } from "./worker-config";
import { ollamaImageSetupIssue } from "./ollama-image-config";
import { huggingFaceSetupIssue } from "./huggingface-image-config";

// Configuration hints only. Admission still checks adapters, owner, assets and credits.
export function generationSetupIssue(route: ProviderRoute, env: NodeJS.ProcessEnv = process.env) {
  const local = isLocalGenerationWorkerEnabled(env, env.NODE_ENV);
  if (route === "development-fake" && !local) return "Development placeholder generation requires non-production GENERATION_LOCAL_WORKER_ENABLED=true and GENERATION_LOCAL_WORKER_SECRET.";
  if (route === "external-byok") return "Unavailable: no specifically implemented external BYOK provider integration exists.";
  if (route === "huggingface-image") {
    const issue = huggingFaceSetupIssue(env);
    if (issue) return `Unavailable: ${issue}`;
  }
  if (route === "gcp-hosted-gpu") {
    const issue = ollamaImageSetupIssue(env);
    if (issue) return `Unavailable: ${issue}`;
  }
  if (route === "google-ai-studio-image" && !env.KMS_KEY_RESOURCE?.trim()) return "Application setup required: configure KMS_KEY_RESOURCE to securely use account-scoped Google AI Studio keys.";
  if (route === "vertex-image" || route === "vertex-llm") {
    if (!env.GCP_PROJECT_ID?.trim()) return "Application setup required: configure GCP_PROJECT_ID and the worker's service identity with Vertex AI permissions. Users do not supply cloud keys.";
    if (env.VERTEX_AI_LOCATION !== "global") return "Application setup required: set VERTEX_AI_LOCATION=global for the reviewed Vertex image model.";
  }
  const required = local ? missingLocalGenerationWorkerEnv(env) : (env.ASTRAFLOW_RUNTIME_ROLE === "worker" ? ["WORKER_INVOKER_SERVICE_ACCOUNT_EMAIL", "WORKER_AUDIENCE"] : ["GCP_PROJECT_ID", "GCP_TASKS_LOCATION", "GCP_TASKS_QUEUE", "GENERATION_WORKER_URL", "WORKER_INVOKER_SERVICE_ACCOUNT_EMAIL", "WORKER_AUDIENCE"]).filter((name) => !env[name]?.trim());
  if (required.length) return `Configure generation dispatch: ${required.join(", ")}.`;
  if (route !== "development-fake" && !env.GCS_OUTPUT_BUCKET?.trim()) return "Set GCS_OUTPUT_BUCKET and configure Google application credentials and bucket permissions for generated images.";
  return null;
}
