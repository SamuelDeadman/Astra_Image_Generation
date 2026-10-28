# Hugging Face image worker

Separate private Linux/CUDA backend for the existing Node generation worker. The Ollama backend is preserved.

`Dockerfile` extends the official Google/Hugging Face PyTorch inference DLC with an isolated, pinned Diffusers runtime and a small image API. TGI and TEI are for other tasks. The upstream DLC's old inference toolkit and Flash Attention installation are isolated from this server. Release builds supply `HF_DLC_IMAGE` as a reviewed registry digest; deployed images also require immutable digests.

The code-owned model array is [huggingface-models.json](../../src/lib/models/huggingface-models.json), copied into both images. It pins the official Z-Image Turbo and distilled FLUX.2 Klein 4B repositories to commits. These load official safetensors into BF16 with CPU offload, independently of Ollama's FP8 format. One 1024×1024 PNG per text-to-image request; no arbitrary repositories, remote code, pickle weights, LoRAs, external endpoints or client-controlled diffusion settings.

`Dockerfile.cache` is a CPU-only preparation job. It downloads each required file once, verifies the Hub content hash, uploads immutable objects to private GCS, and publishes `READY.json` last. Re-running verifies the cached objects without Hub calls or weight downloads. Interrupted runs resume completed objects. The job cannot overwrite or delete snapshots. GPU instances mount the completed snapshot read-only and load with `local_files_only=True` and Hub offline mode.

The server exposes `GET /healthz` after catalogue/configuration checks, ML imports and CUDA availability checks. Model weights load lazily inside the inference request so the startup probe does not wait for both models. A single executor and admission lock serialize work and keep probes responsive. Switching models releases the previous pipeline; cancellation/deadlines are checked after loading and between diffusion steps. A cancelled request retains the lock until its CUDA work stops.

`POST /v1/images/generations` accepts exactly `model`, `revision`, `catalogue_sha256`, `prompt`, `width`, `height`, and `timeout_seconds`. The Node worker constructs this payload from a validated, authoritative workflow. Cloud Run IAM admits only the Node service identity with a separate Google-signed ID-token audience. Success returns PNG bytes and model/revision/catalogue headers, which Node verifies before the existing private output-storage and credit lifecycle runs. Raw prompts and provider exceptions are not logged.

See [deployment and activation](../../docs/huggingface-image-generation.md). Docker, Terraform provider validation, actual model loading and real L4 generation must be checked in the deployment environment; local contract tests use fake providers and do not establish GPU compatibility or latency.
