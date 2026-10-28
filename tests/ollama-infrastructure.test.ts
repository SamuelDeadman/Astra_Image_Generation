import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import Module from "node:module";
import path from "node:path";
import test from "node:test";
import { authenticateGenerationWorkerRequest } from "../src/server/generations/worker-auth";
import { createWorkerTaskPayload } from "../src/server/generations/worker-contract";

const read = (file: string) => readFileSync(path.join(process.cwd(), file), "utf8");

test("the selected FP8 image model is explicit and remains gated for unverified Linux/L4 execution", () => {
  const selection = JSON.parse(read("terraform/ollama-model-selection.json"));
  assert.equal(selection.reference, "x/flux2-klein:4b-fp8");
  assert.equal(selection.quantization, "fp8");
  assert.deepEqual(selection.recommended_size, { width: 1024, height: 1024 });
  assert.equal(selection.manifest_digest, JSON.parse(read("workers/gpu/model-lock.json")).manifest_digest);
  assert.equal(selection.auto_pull_enabled, false);
  assert.equal(selection.image_generation_enabled, false);
  assert.equal(selection.compatibility.target, "linux-amd64/nvidia-l4");
  assert.equal(selection.compatibility.status, "blocked");
  assert.match(selection.compatibility.reason, /rejects image-generation models with HTTP 400/);
  assert.equal(selection.compatibility.container_version_checked, "0.40.6");
  assert.match(selection.compatibility.container_index_digest_checked, /^sha256:[a-f0-9]{64}$/);
  assert.ok(selection.compatibility.sources.includes("https://ollama.com/x/flux2-klein"));
  assert.match(read("terraform/locals.tf"), /ollama_model_selection\s*=\s*jsondecode\(file\("\$\{path.module\}\/ollama-model-selection.json"\)\)/);
  assert.match(read("terraform/outputs.tf"), /value\s*=\s*local.ollama_model_selection/);
  for (const environment of ["dev", "prod"]) {
    assert.match(read(`terraform/environments/${environment}/main.tf`), /model_selection\s*=\s*module.platform.ollama_model_selection/);
  }
  // The candidate has code-owned constraints; configuration and live evidence gate admission.
  const model = JSON.parse(read("src/lib/models/definitions.json")).find((entry: { id: string }) => entry.id === "ollama-flux2-klein-4b-fp8");
  assert.equal(model.providerModelId, selection.reference);
  assert.deepEqual(model.capabilities, ["text-to-image"]);
  assert.doesNotMatch(read("terraform/modules/gpu-worker/main.tf"), /ollama run|ollama pull|OLLAMA_MODEL|model_selection/);
});

// Configuration regression checks only; these do not replace Terraform provider validation.
function block(source: string, declaration: string) {
  const start = source.indexOf(declaration);
  assert.notEqual(start, -1, declaration);
  const opening = source.indexOf("{", start);
  let depth = 0;
  let quoted = false;
  for (let i = opening; i < source.length; i++) {
    const char = source[i];
    if (char === '"' && source[i - 1] !== "\\") quoted = !quoted;
    if (quoted) continue;
    if (char === "{") depth++;
    if (char === "}" && --depth === 0) return source.slice(opening, i + 1);
  }
  throw new Error("Unclosed Terraform block: " + declaration);
}

test("environments select Ollama independently from the Node image and keep GPU opt-in", () => {
  const dev = read("terraform/environments/dev/terraform.tfvars");
  assert.match(dev, /gpu_worker_container_image\s*=\s*"ollama\/ollama:latest"/);
  for (const environment of ["dev", "prod"]) {
    const values = read(`terraform/environments/${environment}/terraform.tfvars`);
    const wrapper = read(`terraform/environments/${environment}/main.tf`);
    assert.match(values, /gpu_worker_enable_gpu\s*=\s*false/);
    assert.match(values, /gpu_worker_runtime\s*=\s*"ollama"/);
    assert.match(values, /generation_worker_url\s*=\s*""/);
    assert.match(values, /gcp_gpu_execution_url\s*=\s*""/);
    assert.match(values, /gpu_worker_model_bucket_name\s*=\s*""/);
    for (const variable of ["generation_worker_container_image", "generation_worker_service_name", "generation_worker_max_instances", "gpu_worker_runtime", "ollama_audience", "ollama_image_generation_enabled", "ollama_service_url", "ollama_model_digest"]) {
      assert.ok(wrapper.includes(`var.${variable}`), variable);
      assert.ok(wrapper.includes(`variable "${variable}"`), variable);
    }
    assert.match(wrapper, /output "generation_worker"/);
    assert.match(wrapper, /output "ollama"/);
  }
  const variables = read("terraform/variables.tf");
  assert.match(block(variables, 'variable "ollama_image_generation_enabled"'), /default\s*=\s*false/);
  for (const variable of ["gpu_worker_container_image", "generation_worker_container_image"]) {
    const image = block(block(variables, `variable "${variable}"`), "validation");
    assert.match(image, /var.environment != "prod"/);
    assert.ok(image.includes("@sha256:[a-f0-9]{64}$"), "production digest rule retained");
    assert.doesNotMatch(image, /latest/); // No mutable-tag exception inside validation.
  }
});

test("Cloud Tasks targets Node with the original identity/audience and waits for its IAM", () => {
  const locals = read("terraform/locals.tf");
  assert.match(locals, /GENERATION_WORKER_URL\s*=.*module.generation_worker.worker_endpoint/);
  assert.doesNotMatch(locals, /GENERATION_WORKER_URL\s*=.*module.gpu_worker/);
  assert.equal((locals.match(/WORKER_AUDIENCE\s*=\s*local.generation_worker_audience/g) ?? []).length, 2);
  assert.match(locals, /generation_worker_audience\s*=.*var.worker_audience.*local.gpu_worker_audience/);
  assert.match(locals, /WORKER_INVOKER_SERVICE_ACCOUNT_EMAIL\s*=\s*module.iam.task_invoker_service_account_email/);
  const main = read("terraform/main.tf");
  const worker = block(main, 'module "generation_worker"');
  assert.match(worker, /container_image\s*=\s*local.generation_worker_image/);
  assert.match(worker, /service_account_email\s*=\s*module.iam.worker_runtime_service_account_email/);
  assert.match(locals, /generation_worker_image\s*=\s*coalesce\(var.generation_worker_container_image, var.container_image\)/);
  const node = read("terraform/modules/generation-worker/main.tf");
  assert.match(node, /custom_audiences\s*=\s*\[var.audience\]/);
  assert.match(node, /INGRESS_TRAFFIC_INTERNAL_ONLY/);
  assert.match(node, /invoker_iam_disabled\s*=\s*false/);
  assert.match(node, /member\s*=\s*"serviceAccount:\$\{var.task_invoker_service_account_email\}"/);
  assert.doesNotMatch(node, /allUsers|nvidia.com\/gpu|ollama\/ollama/);
  assert.match(read("terraform/modules/generation-worker/outputs.tf"), /depends_on\s*=\s*\[google_cloud_run_v2_service_iam_member.task_invoker\]/);
});

test("Ollama is isolated, private, correctly probed and requests exactly one L4 when enabled", () => {
  const main = read("terraform/main.tf");
  const gpu = block(main, 'module "gpu_worker"');
  assert.match(gpu, /container_image\s*=.*local.generation_worker_image : var.gpu_worker_container_image/);
  assert.match(gpu, /service_account_email\s*=.*: google_service_account.ollama_runtime.email/);
  assert.match(gpu, /secret_environment_variables\s*=.*: \{\}/);
  assert.match(gpu, /health_path\s*=.*: "\/api\/version"/);
  assert.match(gpu, /audience\s*=.*: local.ollama_audience/);
  const locals = read("terraform/locals.tf");
  const ollama = block(locals, "ollama_environment_variables =");
  assert.match(ollama, /OLLAMA_HOST\s*=\s*"0.0.0.0:\$\{var.gpu_worker_container_port\}"/);
  assert.doesNotMatch(ollama, /MONGODB|KMS|GCS|GPU_MODEL_BUCKET|WORKER_AUDIENCE|pull|phi4/i);
  const runtime = read("terraform/modules/gpu-worker/main.tf");
  assert.match(runtime, /accelerator\s*=\s*"nvidia-l4"/);
  assert.match(runtime, /var.enable_gpu \? \{ "nvidia.com\/gpu" = tostring\(var.gpu_count\) \} : \{\}/);
  assert.match(runtime, /cpu_idle\s*=\s*false/);
  assert.match(runtime, /invoker_iam_disabled\s*=\s*false/);
  assert.match(runtime, /min_instance_count\s*=\s*0/);
  assert.match(runtime, /tonumber\(var.cpu\) >= 4/);
  assert.match(runtime, /var.audience != var.task_audience/);
  assert.equal((runtime.match(/path = var.health_path/g) ?? []).length, 2);
  assert.match(runtime, /failure_threshold\s*=\s*48/);
  assert.doesNotMatch(runtime, /failure_threshold\s*=\s*var.timeout_seconds|allUsers|sleep|ollama pull/);
  const gpuVariables = read("terraform/modules/gpu-worker/variables.tf");
  assert.match(block(gpuVariables, 'variable "gpu_count"'), /var.gpu_count == 1/);
  assert.match(block(gpuVariables, 'variable "ingress"'), /INGRESS_TRAFFIC_INTERNAL_ONLY/);
  assert.match(block(gpuVariables, 'variable "max_instance_request_concurrency"'), /default\s*=\s*1/);
  // Native invocation grants only the Node runtime identity and remains opt-in.
  assert.match(runtime, /count = var.legacy_node_enabled \? 1 : 0/);
  assert.equal((main.match(/google_service_account.ollama_runtime.email/g) ?? []).length, 1);
  assert.doesNotMatch(block(locals, "cloud_run_environment_variables ="), /OLLAMA_SERVICE_URL|OLLAMA_AUDIENCE/);
  assert.match(block(locals, "generation_worker_environment_variables ="), /OLLAMA_SERVICE_URL\s*=.*var.ollama_service_url/);
  const invoker = block(main, 'resource "google_cloud_run_v2_service_iam_member" "ollama_node_invoker"');
  assert.match(invoker, /var.ollama_image_generation_enabled \? 1 : 0/);
  assert.match(invoker, /member\s*=\s*"serviceAccount:\$\{module.iam.worker_runtime_service_account_email\}"/);
  assert.doesNotMatch(invoker, /app_runtime|task_invoker_service_account_email|allUsers/);
  assert.match(invoker, /var.gpu_worker_enable_gpu && var.create_vpc_connector/);
  assert.match(block(main, 'module "generation_worker"'), /var.ollama_image_generation_enabled \|\| var.huggingface_image_generation_enabled \? "ALL_TRAFFIC"/);
  assert.match(block(main, 'module "generation_worker"'), /direct_vpc_subnetwork\s*=\s*var.ollama_image_generation_enabled \|\| var.huggingface_image_generation_enabled \? module.networking.subnetwork_id : null/);
  assert.match(read("terraform/modules/generation-worker/main.tf"), /dynamic "network_interfaces"/);
  assert.match(block(read("terraform/modules/networking/main.tf"), 'resource "google_compute_subnetwork" "serverless"'), /private_ip_google_access\s*=\s*true/);
  assert.match(read("terraform/modules/networking/main.tf"), /source_subnetwork_ip_ranges_to_nat\s*=\s*"ALL_SUBNETWORKS_ALL_IP_RANGES"/);
});

test("migration retains the old Node route until queues drain and orders producer before conversion", () => {
  const main = read("terraform/main.tf");
  const gpu = block(main, 'module "gpu_worker"');
  assert.match(gpu, /legacy_node_enabled\s*=\s*local.legacy_node_enabled/);
  assert.match(gpu, /environment_variables\s*=.*local.generation_worker_environment_variables : local.ollama_environment_variables/);
  assert.match(gpu, /depends_on\s*=\s*\[module.iam, module.cloud_run, google_storage_bucket_iam_member.ollama_model_reader\]/);
  assert.match(block(main, 'module "cloud_run"'), /depends_on\s*=\s*\[module.iam, module.generation_worker\]/);
  const runtime = read("terraform/modules/gpu-worker/main.tf");
  assert.match(runtime, /moved\s*\{\s*from = google_cloud_run_v2_service_iam_member.task_invoker\s*to\s*= google_cloud_run_v2_service_iam_member.task_invoker\[0\]/);
});

test("cache preparation and inference share the fixed digest and isolate immutable GCS access", () => {
  const lock = JSON.parse(read("workers/gpu/model-lock.json"));
  const selection = JSON.parse(read("terraform/ollama-model-selection.json"));
  assert.equal(lock.model, "x/flux2-klein:4b-fp8");
  assert.equal(selection.manifest_digest, lock.manifest_digest);
  assert(read("src/lib/models/ollama-image.ts").includes(lock.manifest_digest));
  assert(read("terraform/variables.tf").includes(lock.manifest_digest));
  const cache = read("terraform/ollama-cache.tf");
  const bucket = block(cache, 'resource "google_storage_bucket" "ollama_models"');
  assert.match(bucket, /uniform_bucket_level_access\s*=\s*true/);
  assert.match(bucket, /public_access_prevention\s*=\s*"enforced"/);
  assert.match(bucket, /force_destroy\s*=\s*false/);
  assert.match(bucket, /location\s*=\s*var.region/);
  assert.match(cache, /roles\/storage.objectCreator/);
  assert.doesNotMatch(cache, /allUsers|roles\/storage.objectAdmin|roles\/storage.admin|app_runtime|worker_runtime/);
  assert.match(block(cache, 'resource "google_storage_bucket_iam_member" "ollama_model_reader"'), /roles\/storage.objectViewer/);
  assert.match(block(cache, 'resource "google_cloud_run_v2_job" "ollama_cache_seed"'), /task_count\s*=\s*1/);
  assert.doesNotMatch(block(cache, 'resource "google_cloud_run_v2_job" "ollama_cache_seed"'), /nvidia|local-exec|provisioner/);
  const gpu = read("terraform/modules/gpu-worker/main.tf");
  assert.match(gpu, /read_only\s*=\s*true/);
  assert.match(gpu, /only-dir=\$\{var.model_cache_prefix\}/);
  assert.match(gpu, /file-cache:max-size-mb=0/);
  assert.match(read("terraform/locals.tf"), /OLLAMA_MODELS\s*=\s*"\/models"/);
  assert.match(read("terraform/main.tf"), /jsondecode\(data.google_storage_bucket_object_content.ollama_cache_ready\[0\].content\).manifest_digest/);
  for (const environment of ["dev", "prod"]) {
    const wrapper = read(`terraform/environments/${environment}/main.tf`);
    for (const variable of ["ollama_model_cache_enabled", "ollama_model_cache_ready", "ollama_model_cache_bucket_name", "ollama_cache_seed_container_image"]) {
      assert(wrapper.includes(`variable "${variable}"`));
      assert(wrapper.includes(`var.${variable}`));
    }
    assert(wrapper.includes("module.platform.ollama_model_cache"));
  }
});

test("real dispatcher retains strict task body and sends the Node URL and task OIDC settings", async () => {
  const captured: Array<{ parent: string; task: { httpRequest: { url: string; httpMethod: string; body: string; oidcToken: { serviceAccountEmail: string; audience: string } }; dispatchDeadline: { seconds: number } } }> = [];
  const env = {
    GCP_PROJECT_ID: "project",
    GCP_TASKS_LOCATION: "europe-west1",
    GCP_TASKS_QUEUE: "generation",
    GENERATION_WORKER_URL: "https://node-worker.run.app/api/internal/generation-worker",
    WORKER_INVOKER_SERVICE_ACCOUNT_EMAIL: "tasks@project.iam.gserviceaccount.com",
    WORKER_AUDIENCE: "https://run.googleapis.com/projects/project/locations/europe-west1/services/old-gpu-worker"
  };
  const previous = Object.fromEntries(Object.keys(env).map((key) => [key, process.env[key]]));
  Object.assign(process.env, env);
  const loader = Module as unknown as { _load(request: string, parent: unknown, isMain: boolean): unknown };
  const originalLoad = loader._load;
  loader._load = function (request, parent, isMain) {
    if (request === "server-only") return {};
    if (request === "@google-cloud/tasks") return {
      CloudTasksClient: class {
        queuePath(project: string, location: string, queue: string) { return `projects/${project}/locations/${location}/queues/${queue}`; }
        async createTask(input: (typeof captured)[number]) { captured.push(input); return [{ name: "tasks/created" }]; }
      }
    };
    return originalLoad.call(this, request.startsWith("@/") ? path.join(process.cwd(), "src", request.slice(2)) : request, parent, isMain);
  };
  try {
    const { enqueueGenerationTask } = await import("../src/server/gcp/tasks");
    assert.equal(await enqueueGenerationTask({ jobId: "job", workflowVersionId: "revision", attemptId: "attempt" }), "tasks/created");
    assert.equal(captured.length, 1);
    assert.equal(captured[0].parent, "projects/project/locations/europe-west1/queues/generation");
    const request = captured[0].task.httpRequest;
    assert.equal(request.url, env.GENERATION_WORKER_URL);
    assert.equal(request.httpMethod, "POST");
    assert.deepEqual(request.oidcToken, { serviceAccountEmail: env.WORKER_INVOKER_SERVICE_ACCOUNT_EMAIL, audience: env.WORKER_AUDIENCE });
    assert.deepEqual(JSON.parse(Buffer.from(request.body, "base64").toString()), createWorkerTaskPayload({ jobId: "job", workflowRevisionId: "revision", attemptId: "attempt" }));
    assert.equal(captured[0].task.dispatchDeadline.seconds, 1800);
  } finally {
    loader._load = originalLoad;
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});

test("Node endpoint authenticates before parsing and keeps lifecycle response/retry semantics", async () => {
  const config = { localWorkerEnabled: false, expectedAudience: "task-audience", expectedServiceAccountEmail: "tasks@project.iam.gserviceaccount.com", nodeEnv: "production" };
  let outcome = "completed";
  const received: unknown[] = [];
  const loader = Module as unknown as { _load(request: string, parent: unknown, isMain: boolean): unknown };
  const originalLoad = loader._load;
  loader._load = function (request, parent, isMain) {
    if (request === "@/server/generations/worker") return { runGenerationWorkerTask: async (payload: unknown) => { received.push(payload); return { outcome }; } };
    if (request === "@/server/generations/worker-auth") return {
      authenticateGenerationWorkerRequest: (headers: Headers) => authenticateGenerationWorkerRequest(headers, {
        config,
        verifyOidcToken: async ({ idToken }) => ({
          iss: "https://accounts.google.com",
          aud: idToken === "wrong-audience" ? "ollama-audience" : config.expectedAudience,
          email: idToken === "wrong-identity" ? "ollama@project.iam.gserviceaccount.com" : config.expectedServiceAccountEmail,
          email_verified: true
        })
      })
    };
    return originalLoad.call(this, request.startsWith("@/") ? path.join(process.cwd(), "src", request.slice(2)) : request, parent, isMain);
  };
  try {
    const { POST } = await import("../src/app/api/internal/generation-worker/route");
    const request = (body: string, token?: string) => new Request("https://node-worker.run.app/api/internal/generation-worker", {
      method: "POST", body, headers: token ? { authorization: `Bearer ${token}` } : {}
    });
    assert.equal((await POST(request("invalid json"))).status, 401);
    assert.equal((await POST(request("{}", "wrong-audience"))).status, 401);
    assert.equal((await POST(request("{}", "wrong-identity"))).status, 401);
    assert.equal((await POST(request(JSON.stringify({ model: "arbitrary-model" }), "valid"))).status, 400);
    assert.equal(received.length, 0);
    const payload = createWorkerTaskPayload({ jobId: "job", workflowRevisionId: "revision", attemptId: "attempt" });
    for (const [nextOutcome, status] of [["completed", 200], ["retry", 503], ["rejected", 202]] as const) {
      outcome = nextOutcome;
      const response = await POST(request(JSON.stringify(payload), "valid"));
      assert.equal(response.status, status);
      assert.deepEqual(await response.json(), { result: { outcome } });
    }
    assert.deepEqual(received, [payload, payload, payload]);
  } finally {
    loader._load = originalLoad;
  }
});
