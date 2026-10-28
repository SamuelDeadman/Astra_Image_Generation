import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const read = (file: string) => readFileSync(file, "utf8");
test("HF inference requests one private L4, scales to zero and mounts a read-only prepared cache", () => {
  const infrastructure = read("terraform/huggingface.tf");
  assert.match(infrastructure, /INGRESS_TRAFFIC_INTERNAL_ONLY/);
  assert.match(infrastructure, /invoker_iam_disabled\s*=\s*false/);
  assert.match(infrastructure, /custom_audiences\s*=\s*\[local.hf_audience\]/);
  assert.match(infrastructure, /accelerator = "nvidia-l4"/);
  assert.match(infrastructure, /"nvidia.com\/gpu" = "1"/);
  assert.match(infrastructure, /min_instance_count\s*=\s*0/);
  assert.match(infrastructure, /max_instance_request_concurrency\s*=\s*1/);
  assert.match(infrastructure, /memory = "32Gi"/);
  assert.match(infrastructure, /read_only\s*=\s*true/);
  assert.match(infrastructure, /local.hf_cache_verified && var.huggingface_container_image != null && var.create_vpc_connector/);
  assert.match(infrastructure, /member\s*=\s*"serviceAccount:\$\{module.iam.worker_runtime_service_account_email\}"/);
  assert.doesNotMatch(infrastructure, /allUsers|roles\/storage.objectAdmin|roles\/secretmanager.secretAccessor/);
  assert.match(infrastructure, /public_access_prevention\s*=\s*"enforced"/);
  assert.match(infrastructure, /force_destroy\s*=\s*false/);
  assert.match(infrastructure, /roles\/storage.objectCreator/);
  assert.match(infrastructure, /sha256\(jsonencode\(local.hf_catalogue\)\)/);
});

test("both environment wrappers expose HF preparation and inference separately, disabled by default", () => {
  const variables = ["huggingface_enabled", "huggingface_image_generation_enabled", "huggingface_model_cache_ready", "huggingface_container_image", "huggingface_cache_seed_container_image", "huggingface_model_cache_bucket_name", "huggingface_max_instances"];
  for (const environment of ["dev", "prod"]) {
    const wrapper = read(`terraform/environments/${environment}/main.tf`);
    const settings = read(`terraform/environments/${environment}/huggingface.tf`);
    for (const name of variables) { assert.ok(wrapper.includes(`var.${name}`)); assert.ok(settings.includes(`variable "${name}"`)); }
    assert.equal((settings.match(/default = false/g) ?? []).length, 3);
    assert.match(settings, /value = module.platform.huggingface/);
  }
  const locals = read("terraform/locals.tf");
  const web = locals.slice(locals.indexOf("cloud_run_environment_variables ="), locals.indexOf("cloud_run_secret_environment_variables ="));
  const worker = locals.slice(locals.indexOf("generation_worker_environment_variables ="), locals.indexOf("generation_worker_secret_environment_variables ="));
  assert.match(web, /local.hf_admission_environment/);
  assert.doesNotMatch(web, /HF_SERVICE_URL|HF_AUDIENCE/);
  assert.match(worker, /HF_SERVICE_URL = local.hf_service_url/);
  assert.match(worker, /HF_AUDIENCE\s*= local.hf_audience/);
  assert.match(read("terraform/main.tf"), /var.ollama_image_generation_enabled \|\| var.huggingface_image_generation_enabled \? "ALL_TRAFFIC"/);
});

test("image server extends the general PyTorch DLC and performs offline Diffusers inference", () => {
  const dockerfile = read("workers/huggingface/Dockerfile");
  assert.match(dockerfile, /huggingface-pytorch-inference-cu121/);
  assert.match(dockerfile, /torch==2.6.0.*cu124/);
  assert.match(dockerfile, /USER 10001/);
  assert.match(dockerfile, /HF_HUB_OFFLINE=1 TRANSFORMERS_OFFLINE=1/);
  assert.match(dockerfile, /src\/lib\/models\/huggingface-models.json/);
  const server = read("workers/huggingface/server.py");
  assert.match(server, /local_files_only=True, use_safetensors=True/);
  assert.match(server, /enable_model_cpu_offload/);
  assert.match(server, /ThreadPoolExecutor\(max_workers=1\)/);
  assert.match(server, /callback_on_step_end=step_end/);
  assert.doesNotMatch(server, /trust_remote_code=True|from_pretrained\(model\["repository"\]/);
  assert.match(read("src/server/db/schema.ts"), /"huggingface-l4"/);
  assert.match(read("src/server/db/schema.ts"), /"huggingface-image"/);
});
