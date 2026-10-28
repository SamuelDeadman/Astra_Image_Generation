# AstraFlow Image Studio

Google-authenticated image studio with validated workflows and two private GCP L4 backends: Ollama with fixed `x/flux2-klein:4b-fp8`, and Hugging Face/Diffusers with selectable Z-Image Turbo and FLUX.2 Klein 4B. Both have private durable model caches and scale to zero. Models remain unavailable until configured and live-verified. Other providers and new BYOK credentials remain disabled. See [Hugging Face deployment](docs/huggingface-image-generation.md) and [Ollama preparation](docs/ollama-model-cache.md).

## Stack

- Next.js, React, TypeScript
- Tailwind CSS
- React Flow via `@xyflow/react`
- Zod workflow validation
- Google Identity Services and server-side Google ID token verification
- MongoDB Atlas with the official MongoDB Node.js driver
- Cloud Run-ready Dockerfile

## Local Setup

```bash
npm install
npm run dev
```

Create `.env.local` from `.env.example` and set:

- `GOOGLE_CLIENT_ID`
- `MONGODB_URI`
- `MONGODB_DB_NAME=astraflow_dev`
- `GCS_INPUT_BUCKET`
- `GCS_OUTPUT_BUCKET`
- `GCP_TASKS_QUEUE`
- `GCP_TASKS_LOCATION`
- `GENERATION_WORKER_URL`
- `WORKER_INVOKER_SERVICE_ACCOUNT_EMAIL`
- `WORKER_AUDIENCE`
- `GCP_GPU_EXECUTION_URL` (optional; leave unset until a real GPU step runtime exists)
- `GCP_GPU_EXECUTION_AUDIENCE` (optional)
- `GENERATION_LOCAL_WORKER_ENABLED=false`
- `GENERATION_LOCAL_WORKER_SECRET`
- `GENERATION_LOCAL_OUTPUT_BUCKET=local-dev-generated-output`
- `KMS_KEY_RESOURCE`

Set `GOOGLE_CLIENT_ID` to the Google OAuth Web application client ID. The browser retrieves this public identifier from `/api/auth/config` at runtime, so it does not need to be supplied as a Docker build argument. Terraform takes it once as `next_public_google_client_id` and configures the server-side `GOOGLE_CLIENT_ID` from that value. For local development, set `GOOGLE_CLIENT_ID` in `.env.local`. In Google Console, add the exact site origin, including scheme and port, to **Authorized JavaScript origins** (for local development, add `http://localhost` and the port actually used, such as `http://localhost:3000`). Configure the consent screen and testing audience as needed. Production session cookies require HTTPS. See [Google's setup guide](https://developers.google.com/identity/gsi/web/guides/get-google-api-clientid).

Sign-in uses the existing runtime `GOOGLE_CLIENT_ID` API; Docker and Terraform need no client-ID build argument. Image generation additionally requires a reviewed, live-verified model, authenticated ownership, valid model constraints, dispatch/storage configuration and the existing credit lifecycle.

The current visible catalogue contains `ollama-flux2-klein-4b-fp8`, `hf-z-image-turbo` and `hf-flux2-klein-4b`. The Hugging Face option uses pinned official Diffusers snapshots with BF16 inference with CPU offload on one L4. All entries start disabled until a real Cloud Tasks / worker / inference / private stored-image integration run succeeds for that deployment. The Ollama Linux compatibility gate remains in place.

The Node worker invokes either private backend using Google-signed ID tokens. Users do not supply cloud or Hugging Face keys. Workflow model IDs resolve through the reviewed catalogue; arbitrary repositories, model URLs and provider endpoints are rejected. See [Hugging Face activation](docs/huggingface-image-generation.md) for container builds, cache preparation, MongoDB validator migration and model verification commands.

To create MongoDB validators and indexes in a controlled development setup, temporarily set:

```bash
MONGODB_AUTO_ENSURE_INDEXES=true
```

Then start the app and request `/ready`. After the required collections exist, seed the development provider/model catalogue:

```bash
npm run seed:dev
```

The seed script refuses to run unless `MONGODB_DB_NAME` is exactly `astraflow_dev` and the required collections already exist.

The seed command uses Next.js environment-file loading, including `.env.local`, with existing shell variables taking precedence. It updates development records only; it never creates credentials or enables unlimited credits. Turn `MONGODB_AUTO_ENSURE_INDEXES` off again after controlled setup. `/ready` may still return 503 after creating collections because it also checks authentication, catalogue, live verification, storage, dispatch, inference configuration and KMS. Production accepts its configured database name; the development seed still requires `astraflow_dev`. The private worker uses `ASTRAFLOW_RUNTIME_ROLE=worker` and checks its OIDC configuration rather than browser authentication. Inspect its dependency entries rather than treating its overall status as proof schema creation failed. MongoDB Atlas or a replica set is required for generation transactions.

See [Studio troubleshooting and verification](docs/studio-verification.md) for safe diagnostics, regression commands and the external end-to-end checklist.

## Generation Worker

Cloud Tasks dispatches a strict versioned payload to `POST /api/internal/generation-worker` and uses Google-signed OIDC with `WORKER_INVOKER_SERVICE_ACCOUNT_EMAIL` and `WORKER_AUDIENCE`. The task payload contains only job, workflow revision, attempt, contract, and version identifiers; the worker reloads owner, model, workflow, credit, and asset state from MongoDB.

The `google-ai-studio-image` adapter is an inference provider only. It decrypts the job owner's supported provider credential inside the existing worker execution lifecycle and does not repurpose `GENERATION_WORKER_URL`, `WORKER_AUDIENCE`, or `WORKER_INVOKER_SERVICE_ACCOUNT_EMAIL`.

Terraform routes Cloud Tasks to a separate private Node generation worker. Its `gcp-hosted-gpu` adapter translates validated text-to-image steps into private Ollama image API calls for the fixed `x/flux2-klein:4b-fp8` model and saves verified PNG bytes through the existing output lifecycle. Activation requires immutable pins and successful live deployment verification. The inspected stock Ollama 0.40.6 rejects image generation, so checked-in defaults remain disabled; the cache preparation job must populate the private model bucket before activation. Only the L4/Ollama solution is exposed to users. See [the model cache and deployment guide](docs/ollama-model-cache.md) and [staged infrastructure migration](terraform/README.md).

For local lifecycle review without Cloud Tasks, GCS, or a GPU, opt in explicitly:

```powershell
$env:GENERATION_LOCAL_WORKER_ENABLED="true"
$env:GENERATION_LOCAL_WORKER_SECRET="dev-only-change-me"
$env:GENERATION_LOCAL_OUTPUT_BUCKET="local-dev-generated-output"
& 'F:\Program Files\nodejs\npm.cmd' run dev
```

The local adapter is `development-fake`. It registers a private generated asset marked `DEVELOPMENT ONLY PLACEHOLDER`; it does not upload image bytes to Cloud Storage, so gallery preview/download still require GCS configuration.

See `docs/generation-worker.md` for the worker contract, OIDC requirements, idempotency rules, and remaining production GPU work.

## Workflow JSON

The studio can import and export local workflow JSON files from the Version panel. Export writes the current in-memory graph as a deterministic portable `schemaVersion: 3` document with `executionEnvironment` and strips server/database identity, React Flow UI state, signed URLs, credentials, and binary assets. Import reads local text only, accepts supported schema versions, runs the shared normalization/validation path, and replaces the editor as an unsaved workflow only after validation succeeds.

Workflow execution environments are allowlisted as `gcp-hosted`, `google-ai-studio`, `external-byok`, and `development-local`. The environment is a workflow-level policy; node-level model/provider choices remain visible and must be compatible with the selected environment on the server.

See `docs/workflow-json.md` for the JSON format, import/export limits, asset/model handling, future-node checklist, and review commands.

## Key Files

- `src/app/page.tsx` - studio-first application surface
- `src/components/studio/WorkflowCanvas.tsx` - visual workflow editor
- `src/lib/workflow/schema.ts` - allowlisted workflow schema, port validation, limits, and credit estimation
- `src/lib/workflow/registry.ts` and `src/lib/workflow/graph.ts` - approved node definitions and pure add/remove/import-export graph helpers
- `src/lib/auth/*` and `src/server/auth/*` - Google verification and MongoDB-backed HttpOnly sessions
- `src/lib/providers/adapters.ts` - BYOK provider adapter contract
- `src/server/db/*` - MongoDB connection, collection contracts, validators, and indexes
- `src/server/generations/worker*.ts` - private worker contract, authentication, and lifecycle handling
- `docs/generation-worker.md` - Cloud Tasks OIDC and local fake-worker review notes
- `scripts/seed-dev-catalog.mjs` - safe development provider/model catalogue seed
- `openapi.yaml` - initial API contract
- `docs/security.md` - security controls and non-negotiable boundaries
- `docs/production-roadmap.md` - phased MongoDB-first completion plan

## Generated Assets

The files in `public/images/gallery` are retained as original prototype assets. The app gallery now lists authenticated private asset records from MongoDB and uses short-lived Cloud Storage signed URLs for preview/download.
