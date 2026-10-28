# Z-Image Turbo FP8 on Linux/L4: runtime investigation

Checked **20 October 2026**. Outcome: **vLLM-Omni is the recommended candidate for an isolated Linux/L4 proof of concept**. This recommendation is based on published model/hardware support and registry metadata, not a successful inference run. It is not a deployment or model-activation change.

**Subsequent constraint:** the user requires inference within Ollama itself, so this alternative is not being implemented. The subsequent [stock-image check](ollama-image-support.md) found that the current published Ollama release rejects image-generation models outright. That release-specific evidence supersedes relying only on the older macOS-only model-card warning below.

## Candidate comparison

| Runtime | Evidence | Assessment for AstraFlow |
| --- | --- | --- |
| **vLLM-Omni** | Versioned FP8 documentation explicitly lists `Tongyi-MAI/Z-Image-Turbo`, including text-encoder quantization, and supports NVIDIA SM89. Its GPU installation guide targets Linux. | Best first candidate: documented image serving and model-specific FP8 support. Exact L4 memory, quality and startup behavior still need testing. |
| **Diffusers + PyTorch + torchao** | Official `ZImagePipeline` supports CUDA; torchao integration provides FP8 schemes effective on compute capability 8.9+. | Useful reference implementation and fallback. The combined Z-Image/FP8 package stack needs validation; framework support alone does not prove this exact combination. |
| **SGLang Diffusion** | Official docs cover Linux GPU deployment and Z-Image; a Z-Image-Turbo server example is published. | Plausible alternative, but this investigation did not verify its exact FP8 kernel path on L4. Not the first implementation target. |
| **Ollama** | The selected model card currently restricts image generation to macOS. | Retain the existing private service; it remains gated for this Linux/L4 model. |

Sources: [vLLM-Omni 0.30 FP8 matrix](https://docs.vllm.ai/projects/vllm-omni/en/v0.30.0/user_guide/quantization/fp8/), [Linux GPU installation](https://docs.vllm.ai/projects/vllm-omni/en/latest/getting_started/installation/gpu/), [Diffusers Z-Image](https://huggingface.co/docs/diffusers/api/pipelines/z_image), [Diffusers torchao](https://huggingface.co/docs/diffusers/quantization/torchao), [SGLang Diffusion](https://github.com/sgl-project/sglang/blob/main/docs/docs/sglang-diffusion/index.mdx), [SGLang Z-Image-Turbo serving example](https://github.com/sgl-project/sglang/blob/main/docs/docs/sglang-diffusion/performance-optimization.mdx), [Ollama model card](https://ollama.com/x/z-image-turbo).

NVIDIA lists L4 at compute capability **8.9**. Mapping that to vLLM-Omni's SM89 support is a hardware-compatibility inference; it is not a benchmark or assurance that the complete workload fits. [NVIDIA GPU table](https://developer.nvidia.com/cuda/gpus)

## Model identity and FP8 scope

Keep the user's requested Ollama identity `x/z-image-turbo:fp8` recorded in the existing selection metadata. An alternative runtime would use the original **`Tongyi-MAI/Z-Image-Turbo`** checkpoint in its supported format.

These identify the same model family, but this research has not established that the Ollama package and another FP8 conversion contain identical tensors, quantization scales, component precision or preprocessing. Do not label a converted runtime as the exact Ollama package or claim identical images. A revision change requires independent verification.

vLLM-Omni documents load-time FP8 conversion and component-aware quantization. Eligible transformer/text-encoder linear layers can be FP8 while other components retain checkpoint precision. FP8 weight storage, FP8 matrix operations and FP8 attention are separate capabilities. The L4 candidate must not depend on Hopper-only FP8 attention or Blackwell-only kernels. Validate the actual component dtypes and kernel selection rather than treating `--quantization fp8` as proof of a particular memory footprint. [FP8 configuration](https://docs.vllm.ai/projects/vllm-omni/en/v0.30.0/user_guide/quantization/fp8/), [attention backend limitations](https://docs.vllm.ai/projects/vllm-omni/en/latest/user_guide/diffusion/attention_backends/)

The model owner's example uses **1024 x 1024**, **9 scheduler steps** (8 denoiser evaluations) and **guidance 0.0** for Turbo. Preserve the user's detailed-prompt and quoted-lettering preferences. Begin with text-to-image only; do not inherit generic server examples' 50-step/guidance settings or advertise image editing without separate verification. Negative prompts must be rejected or explicitly handled when Turbo guidance leaves them ineffective. [Original model card and CUDA example](https://huggingface.co/Tongyi-MAI/Z-Image-Turbo), [Diffusers guidance semantics](https://huggingface.co/docs/diffusers/api/pipelines/z_image)

## Concrete artifacts observed, not approved deployment pins

Only small public metadata documents were fetched. Image layers, packages and model weights were not downloaded.

| Item | Observation |
| --- | --- |
| Candidate CUDA image | `vllm/vllm-omni:v0.30.0` |
| Tag/index digest | `sha256:fc77cfaac7b1b43c30cbf32eaea214864434c6e0f303e6e9eb9f64104241a994` |
| Linux/amd64 manifest | `sha256:b09c9eab7d2e30817208de92ccb482756d13d4339377d7cc4c4ce9f47bf04174` |
| Image creation metadata | 25 September 2026 |
| Entrypoint and command | Both unset; an explicit server command is required |
| Sum of compressed image layers | 9,429,963,693 bytes, about 9.43 GB; not runtime RAM use |
| Original model repository revision observed | `f332072aa78be7aecdf3ee76d5c247082da564a6` |
| Model repository license metadata | `apache-2.0`; retain/review all component notices before redistribution |
| Published Omni package inspected | `vllm-omni==0.30.0` |
| Selected package requirements observed | `diffusers==0.40.0`, `accelerate==1.12.0`, `transformers>=5.13.0,<5.15`, `safetensors>=0.8.0` |
| Omni wheel SHA-256 | `141cb0c7b9c07970e5c92a99aab9696e81682dbfa3d2bfcde359c3c1533385f4` |

Provenance: read-only Docker Hub registry manifest/configuration for [the published image](https://hub.docker.com/r/vllm/vllm-omni/tags?name=v0.30.0), [original model API metadata](https://huggingface.co/api/models/Tongyi-MAI/Z-Image-Turbo), and [published Python package metadata](https://pypi.org/pypi/vllm-omni/0.30.0/json). The image labels identify its upstream vLLM base; they do not independently verify the installed Omni package or all dependencies. Check those inside the candidate container during testing.

Use matched vLLM/Omni major-minor versions. The 0.30 versioned guide covers the required FP8 model support; the current main-source installation guide targets a newer vLLM line and is not a drop-in lockfile. For a proof of concept, begin from the observed immutable 0.30 image, inspect its actual packages/CUDA libraries, and record the complete tested stack. No image or model revision above is approved for production by this investigation. [Installation compatibility guidance](https://docs.vllm.ai/projects/vllm-omni/en/latest/getting_started/installation/)

## Proposed private deployment boundary

To retain the existing requirement that `gpu_worker` runs Ollama, the alternative would need a **separate optional private diffusion service**, with its own image, identity and audience. This is a proposal; no service/module was added here.

The existing request path stays browser -> web admission -> Cloud Tasks -> private Node lifecycle worker. Only a future reviewed Node adapter would call the private diffusion endpoint. The Node worker keeps ownership checks, credit handling, retries, cancellation, progress and private asset writes.

The diffusion service would receive no MongoDB, KMS or user-provider secrets. Grant the existing Node runtime service-scoped invocation, mint a Google-signed ID token for the diffusion service's audience, and configure a VPC route satisfying internal ingress. The Cloud Tasks identity/audience stays distinct. Retain Ollama's separate identity/audience; no browsers or workflows choose server URLs, model paths, checkpoints, pull requests or adapters.

vLLM-Omni documents an image endpoint at `POST /v1/images/generations` with `b64_json` output. That endpoint needs a bounded AstraFlow translation layer; it does not implement the task lifecycle or existing GPU step contract. A future adapter must translate typed inputs, reject unsupported controls, enforce a fixed reviewed model, decode/validate the actual image, and use the existing private output upload path. The general server's other endpoints and per-request model/LoRA/path overrides must not become browser capabilities. [Official image-serving quickstart](https://docs.vllm.ai/projects/vllm-omni/en/latest/getting_started/quickstart/)

## Cloud Run feasibility and storage

Cloud Run L4 provides 24 GB VRAM independently of host RAM. Google specifies at least 4 CPU/16Gi and recommends 8 CPU/32Gi. Use **one L4, concurrency 1, min instances 0, max instances 1** as an initial proposed test shape; 8 CPU/32Gi is a starting hypothesis, not a measured sufficient allocation. No quota or allocation was changed. [Cloud Run GPU configuration](https://docs.cloud.google.com/run/docs/configuring/services/gpu)

Measure host RAM, VRAM, disk/cache bytes, quantization/loading peaks, warmup, VAE decoding and encoded output together. FP8 does not remove activation memory, encoder/VAE storage or temporary full-precision loading. CPU offload trades VRAM for host RAM/transfers and needs its own measurements. [Diffusers loading caveats](https://huggingface.co/docs/diffusers/quantization/torchao), [Omni offloading](https://docs.vllm.ai/projects/vllm-omni/en/latest/user_guide/diffusion/cpu_offload/)

For reproducibility, resolve the owner repository to a reviewed commit and record checksums for every required file. Prepare any quantized artifacts in a controlled build with recorded conversion parameters. Validate a runtime-compatible serialized format before assuming load-time quantization can be avoided.

For eventual Cloud Run operation, evaluate an immutable model bundle in a dedicated private GCS prefix, restored into a fresh local directory with checksum verification and atomic completion before model readiness. This would need explicit read-only prefix-scoped access on the new diffusion identity, bounded restore/retry behavior and memory accounting for local files. It is a future lifecycle, not an implementation; the existing `GPU_MODEL_BUCKET` does not provide it. No existing bucket data should be changed.

Google recommends controlled Cloud Storage loading for large models and discusses the tradeoffs against image-baked weights and public downloads. Avoid fetching mutable Hub revisions at each startup. Do not assume a FUSE-mounted model directory supports the runtime's semantics without tests. Local files remain ephemeral after scale-to-zero/replacement. [Cloud Run model-loading guidance](https://docs.cloud.google.com/run/docs/configuring/services/gpu-best-practices)

The observed image is large. A future deployment should mirror the tested artifact into the project's standard Artifact Registry repository, check individual layer sizes and import behavior, and inspect the final model packaging. Google's 9.9 GB restriction for Docker Hub/external remote repositories is **per layer**, not a total-image limit. [Container import restrictions](https://docs.cloud.google.com/run/docs/deploying)

## Proof-of-concept recipe and acceptance evidence

No commands in this section were executed. A model download and GPU benchmark are separate operator work.

After preparing a pinned local owner-model snapshot and a matched runtime environment, the documented serving flags yield this **untested candidate command** inside that environment:

```sh
vllm serve /opt/models/z-image-turbo --omni --quantization fp8 --host 127.0.0.1 --port 8080
```

For future Cloud Run use, bind to `0.0.0.0` and its configured `PORT`, select single-GPU execution, and add proper process/model-readiness handling. Confirm CLI flags against the installed candidate's help. There is no startup sleep, interactive `ollama run` or unrestricted pull. The image has no default entrypoint, so Terraform would need an explicit process command.

Before app activation, collect:

1. Exact container digest, Linux architecture, installed packages, CUDA/driver versions, GPU name/compute capability, model revision/file checksums and quantization component scope.
2. A real BF16 baseline and FP8 images at 1024-square, using ordinary scenes, detailed photorealistic prompts and quoted signage. Verify actual Turbo scheduler/guidance mapping in this server version. Compare quality rather than requiring identical bytes across quantization or hardware.
3. Peak host RAM/VRAM and cold/warm latency; successful fresh-instance loading within configured startup/request budgets; no hidden CPU fallback or OOM.
4. Real PNG bytes decoded successfully with `inspectImageBytes`, expected dimensions, nonempty content, checksum/length verification and private GCS storage through the existing lifecycle.
5. Invocation denied for anonymous/unintended identities; Node ID-token audience accepted; process health separate from model readiness; bounded failures when weights/checksums are missing.
6. Duplicate delivery, cancellation, timeout, corrupt output, retries/refunds and instance replacement tests. A client disconnect alone is not evidence GPU computation stopped; the translation layer must handle cancellation explicitly.

The evidence reviewed makes this a reasonable implementation candidate. It does **not** establish successful real L4 inference, durable caching or a ready AstraFlow model. Existing `gcp-hosted-gpu` remains fail-closed. No Terraform apply, cloud deployment, dependency installation, model download, quantization, benchmark or paid operation was performed.
