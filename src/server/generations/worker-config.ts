export type WorkerEnvironment = NodeJS.ProcessEnv;

export function isLocalGenerationWorkerEnabled(
  env: WorkerEnvironment = process.env,
  nodeEnv = process.env.NODE_ENV
) {
  return nodeEnv !== "production" && env.GENERATION_LOCAL_WORKER_ENABLED === "true";
}

export function getLocalGenerationWorkerSecret(env: WorkerEnvironment = process.env) {
  const value = env.GENERATION_LOCAL_WORKER_SECRET;
  return value && value.trim() ? value : undefined;
}

export function missingLocalGenerationWorkerEnv(env: WorkerEnvironment = process.env) {
  return getLocalGenerationWorkerSecret(env) ? [] : ["GENERATION_LOCAL_WORKER_SECRET"];
}
