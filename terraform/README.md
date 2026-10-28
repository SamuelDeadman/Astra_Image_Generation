# AstraFlow Terraform

The separate Hugging Face L4 backend is configured in `huggingface.tf` and both environment wrappers. It adds a private regional model cache, a CPU preparation job and an opt-in private, scale-to-zero Diffusers service with one L4. Existing Ollama resources remain in place. Follow [Hugging Face deployment](../docs/huggingface-image-generation.md) to build the images, populate both pinned snapshots before activating inference, migrate MongoDB validators and live-verify each model. `huggingface_enabled`, `huggingface_model_cache_ready` and `huggingface_image_generation_enabled` default to false. Both custom images require immutable digests. Terraform creates the preparation job; the deployment pipeline executes it before the second apply. No HF token is needed for the two reviewed public models.

Terraform manages the GCP infrastructure; MongoDB Atlas remains an external dependency. No Terraform apply or GCP deployment was performed for this change.

## Runtime split

| Service/module | Image | Purpose and access |
| --- | --- | --- |
| `cloud_run` / web | Existing Node application image (`container_image`) | Studio and existing public APIs |
| `generation_worker` | Existing Node application image (`generation_worker_container_image`, falling back to `container_image`) | Private Cloud Tasks `POST /api/internal/generation-worker`; existing lifecycle and providers |
| `gpu_worker` | Dev default: `ollama/ollama:latest`; image opt-in and prod require an immutable digest | Private Ollama; optional one L4; gated fixed-model native image adapter |

Bare Ollama does not implement the AstraFlow task endpoint or contract. Cloud Tasks must never target Ollama. The new Node service defaults to `<app>-<environment>-generation-worker`; the existing GPU service name and Terraform resource address remain intact.

The Node service keeps the existing worker identity and MongoDB/KMS/storage/Vertex permissions. It uses port 3000 (the existing standalone Node image), 4 CPU, 16Gi memory, concurrency 1, min instances 0, configurable `generation_worker_max_instances` and timeout 1800 seconds. Its `/healthz` probes check process health; application/model readiness remains separate.

## URLs, audiences and IAM

Leave `generation_worker_url=""` to derive `GENERATION_WORKER_URL` from `module.generation_worker.worker_endpoint`. Overrides are for an externally managed **Node-compatible** handler only; audit any existing override before migration.

`WORKER_INVOKER_SERVICE_ACCOUNT_EMAIL` remains the dedicated task-invoker identity. `WORKER_AUDIENCE` uses `worker_audience`, falling back to the existing `gpu_worker_audience` legacy alias and deterministic resource URI. The audience deliberately retains its old value even though the task endpoint moves. This preserves model-verification fingerprints and task auth semantics. The Node service explicitly registers that custom audience with Cloud Run, in addition to validating the token inside the handler.

Ollama has a different registered `ollama_audience`, defaulting to the legacy GPU resource URI plus `/ollama`. Terraform rejects reusing the task audience in Ollama mode. Its isolated runtime account has no app secrets, KMS, storage or Vertex grants. By default no Ollama caller grant exists. The explicit image-adapter opt-in grants service-scoped invocation only to the Node runtime identity and injects the private URL/audience only into Node. The web receives admission pins and a deployment fingerprint; `GCP_GPU_EXECUTION_URL` is not used by this integration.

Both workers use internal-only ingress and no public invoker binding. The Node service grants invocation only to the Cloud Tasks service account. Same-project Cloud Tasks can use the default `run.app` URL through internal ingress. When image inference is enabled, Node obtains a Google-signed ID token for Ollama and uses Direct VPC egress with `ALL_TRAFFIC` on the explicit subnet with Private Google Access. The existing `create_vpc_connector=true` flag must provision the platform network/subnet; the image caller uses that subnet directly instead of the connector. Cloud NAT provides other outbound traffic, including Atlas. OAuth access tokens cannot replace ID tokens. See [private routing guidance](https://docs.cloud.google.com/run/docs/securing/private-networking), [custom audiences](https://docs.cloud.google.com/run/docs/configuring/custom-audiences) and [service authentication](https://docs.cloud.google.com/run/docs/authenticating/service-to-service).

Root outputs `generation_worker_endpoint` and `generation_worker_audience` are the authoritative task settings. Deprecated root `gpu_worker_endpoint` now aliases the Node endpoint, and `gpu_worker_audience` remains the legacy task-audience alias. Environment outputs clearly separate `generation_worker` and `ollama`; the `gpu_worker` object describes Ollama's deployment and has no task endpoint.

## Required staged migration for existing deployments

Do not directly convert an active Node service to Ollama. Queued tasks contain their original URL, identity and audience; changing the producer does not retarget existing tasks.

1. Save/review the existing service image, port, CPU, memory, timeout, max instances, identity, audiences, overrides and Terraform state. Keep the currently deployed Node image pinned for the migration. Preserve all provider configuration and verification evidence.
2. Set `gpu_worker_runtime="legacy-node"` for the first full plan/apply. Set `generation_worker_container_image` to that existing Node image (a digest in production), and keep `gpu_worker_enable_gpu=false` if that is the current setting. The compatibility mode retains Node, its worker identity, secret config, task-invoker grant and audience at the old GPU service. It uses the old default port 8080; set `gpu_worker_legacy_node_port` to the actual deployed port if different. Preserve any other non-default deployment configuration by reviewing the plan before proceeding.
3. That phase creates the separate private Node worker and invoker grant, then updates the web service's task URL. Explicit dependencies wait for Node invocation IAM before updating the producer. If `generation_worker_url` was an override pointing at the old service, clear it or replace it with the new Node endpoint during this phase.
4. Verify a controlled authenticated task reaches the new Node endpoint with the strict existing body and expected audience/identity. Verify existing providers and model readiness. Wait until old web revisions and external producers no longer enqueue to the old URL, all in-flight old requests finish, and every old-URL queued/retry/scheduled task drains. Do not purge the queue or discard jobs; keep the legacy Node service available until deliveries finish. If draining cannot be guaranteed, stop the migration here.
5. Only after that evidence, set `gpu_worker_runtime="ollama"` and plan/apply phase two. This changes the existing GPU service image, identity, health probes and port, and removes the old task-invoker grant. No service or bucket is renamed/deleted. The `moved` block preserves the old IAM resource address when introducing its conditional migration grant.
6. Verify Ollama process health privately through an authorized internal operator path; separately inspect IAM denial for unauthenticated callers and the task identity. Review quota and explicitly set `gpu_worker_enable_gpu=true` only when an L4 deployment is intended. Do not enable an app image route.

The dependency graph orders Node/IAM -> web producer -> GPU conversion, but it cannot prove a queue is drained or stop stale producers. The two phases are mandatory for an active deployment. During rollback, keep the new Node URL as the task target; never restore a task URL to an Ollama revision. Recover the legacy Node image/identity/IAM first if old-URL tasks remain.

For a fresh deployment without old tasks, normal `gpu_worker_runtime="ollama"` is appropriate. Safe checked-in defaults do not allocate GPU or activate inference.

## Ollama image promotion and runtime

Development tfvars selects exactly `ollama/ollama:latest`. The tag is mutable, Cloud Run revisions resolve an image at deployment, and an unchanged tag does not guarantee Terraform will roll a fresh revision. Record the resolved digest and version for every test; deliberately roll a reviewed revision when testing a changed tag.

On a Docker-capable operator machine (commands below are manual, not executed by this task):

```powershell
docker pull --platform linux/amd64 ollama/ollama:latest
docker buildx imagetools inspect ollama/ollama:latest
docker image inspect ollama/ollama:latest --format '{{json .RepoDigests}} {{json .Config.Entrypoint}} {{json .Config.Cmd}} {{json .Config.Env}}'
```

Record the index and Linux/amd64 manifest digests. Use the **recorded immutable reference** for subsequent tests, rather than resolving `latest` again. Test it locally on Linux/L4 where available, then in an explicitly authorized private development L4 revision. Check `/api/version`, `/api/tags`, GPU discovery/driver compatibility and cold starts. No model is needed for process-health checks; an empty model list is expected on a fresh instance but was not runtime-verified here. Confirm anonymous and unintended identities cannot invoke it. After review, set production `gpu_worker_container_image="ollama/ollama@sha256:<tested-digest>"` (or the corresponding unchanged mirrored artifact digest) and `generation_worker_container_image` to the tested **Node** digest. Replace all production placeholders before deployment.

Production digest validation remains intact for Ollama and also covers the separate Node worker. A production `latest` tag is rejected; the existing explicit `replace-me` scaffold exception is not a deployable image.

Ollama uses its native `/bin/ollama serve` startup and `OLLAMA_HOST=0.0.0.0:11434` (or the configured port). Startup/liveness use `GET /api/version`, not Node's probes. Startup has a 240-second budget independent of the request timeout. No sleep, shell wrapper, pull, runtime model setting or command override is added. Process health does not establish model readiness or image generation.

When `gpu_worker_enable_gpu=true`, Terraform requests one NVIDIA L4 with at least 4 CPU and 16Gi memory, instance-based CPU allocation, concurrency 1, scale-to-zero and bounded maximum instances. Review regional L4 quota and GPU zonal redundancy requirements first. The default 1800-second timeout is for HTTP requests, not startup. [Cloud Run's GPU documentation](https://docs.cloud.google.com/run/docs/configuring/services/gpu) and [Ollama hardware support](https://docs.ollama.com/gpu) document compatibility; actual L4 use must still be tested.

## Models and persistence

The fixed model is `x/flux2-klein:4b-fp8`. GCP hosted worker now selects only its L4/Ollama route; other user-facing inference solutions are disabled. A private regional GCS cache, CPU preparation job and read-only FUSE mount are implemented. The model manifest digest is pinned across application, seeder and Terraform metadata. See [the cache design and deployment stages](../docs/ollama-model-cache.md).

Prepare the cache once during deployment using `workers/gpu/Dockerfile.cache` and `scripts/prepare-ollama-model-cache.ps1`. Set `ollama_cache_seed_container_image` to the published preparation image digest, then run its CPU-only job. After successful preparation set `ollama_model_cache_ready=true`; Terraform verifies the completion marker before mounting the immutable prefix. Ollama receives object viewer only; the preparation identity receives object viewer/creator without overwrite/delete. The cache bucket enforces private uniform IAM, versioning and `force_destroy=false`. This is durable model storage, not a public Cloud CDN.

The GPU service remains at minimum instances zero and reloads weights from GCS on cold instances. Model files in this bucket survive instance termination. The old `gpu_worker_model_bucket_name` input remains a separate legacy Node-only grant and is not this cache. Stock Ollama image generation remains blocked on Linux, including the FLUX model card's macOS-only restriction; cache preparation does not remove that blocker. Compatible immutable runtime and live generated-image verification remain mandatory before activation. No cache job or GCP deployment was executed by this implementation.

## Environment setup and validation

The root is a reusable platform module. `environments/dev` and `environments/prod` are deployment roots; their tfvars, wrapper inputs and outputs are kept consistent.

Before any authorized deployment, create/select the project and external state bucket, configure Artifact Registry and the existing Node build/push flow, populate Secret Manager privately, and configure MongoDB Atlas/database user/network access externally. `next_public_google_client_id` is passed at runtime as `GOOGLE_CLIENT_ID` for `/api/auth/config`; no client-ID build argument is needed. Inject `TF_VAR_mongodb_atlas_uri` and other secrets through a secret store/CI, never committed tfvars or logs. Secret versions managed by Terraform are stored in state. Existing app/session/provider secrets and private asset buckets retain their existing controls.

When Terraform is installed and the selected environment is initialized, run:

```powershell
terraform fmt -check -recursive terraform
terraform -chdir=terraform/environments/dev validate
# Review a plan in the established initialized environment, including the migration phase.
terraform -chdir=terraform/environments/dev plan -var-file=terraform.tfvars
```

Initialize only as an intentional operator step using that environment's reviewed `backend.hcl`. Repeat for production, review every resource/IAM change and digest, and verify no raw secrets or unexpected storage changes appear. Apply only through the existing authorized deployment process.

The initial infrastructure split passed 73 tests across infrastructure/dispatch/endpoint, worker, catalogue/provider, workflow, Studio and Google-auth suites. The Z-Image FP8 selection follow-up passed all 7 infrastructure/selection checks, 11 worker tests and 21 catalogue/provider tests (39 focused tests); typechecking with `--incremental false` and focused ESLint also passed again. Suites use the existing `node node_modules/sucrase/bin/sucrase-node tests/<suite>.test.ts` runner. The first default incremental typecheck attempt during the infrastructure split could not write the sandbox-protected build-info cache; disabling that cache passed. Static variable-reference checks passed for the root, both wrappers and both worker modules. No dependencies were installed.

Static Terraform assertions are regression checks, not provider validation. Terraform and Docker are unavailable in the implementation environment; Terraform fmt/validate/plan and container execution were not run. The environment directories have lockfiles but no initialized provider directory. Only public image metadata and official documentation/provider source were inspected. No live apply, GCP deployment, model installation, cloud-cost operation, real L4 inference or persistence verification was performed.
