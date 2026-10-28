# Published Ollama image: image-output support check

Historical runtime finding from 20 October 2026. The current fixed selection is `x/flux2-klein:4b-fp8`; its private cache and activation requirements are documented in [the current deployment guide](../../docs/ollama-model-cache.md). The compatibility blocker described here is still enforced.

Checked **20 October 2026** following the requirement that inference must run inside the stock Ollama container itself.

## Result

The current stock `ollama/ollama:latest` image cannot provide the requested image-generation flow. Selecting another image model does not resolve the checked runtime's explicit capability rejection. No replacement model has been selected, downloaded or enabled, and no app inference adapter has been advertised as working.

This finding is more specific than the model cards' older macOS-only wording.

## Evidence

Read-only Docker Hub manifest requests returned the same index digest for both `latest` and `0.40.6`:

```text
sha256:265409e1d931028a8f7d5a32bcbafddd7bffbc6cc629d77efe9560adf692a5e7
```

In the [official 0.40.6 generation handler](https://github.com/ollama/ollama/blob/v0.40.6/server/routes.go), a model advertising `CapabilityImage` is rejected with `http.StatusBadRequest` and:

```text
image generation models are not currently supported
```

This applies to the capability, rather than a particular model name. The [release's source tree](https://github.com/ollama/ollama/tree/v0.40.6) also has no imagegen/ZImage/Flux2 inference implementation under the previously used paths. The repository tree was inspected as metadata; source code was not compiled or executed.

The [same release's Dockerfile](https://github.com/ollama/ollama/blob/v0.40.6/Dockerfile) includes a CUDA/MLX payload, and its [developer guide](https://github.com/ollama/ollama/blob/v0.40.6/docs/development.md) describes CUDA MLX builds. That backend's existence alone does not establish image-output support: the HTTP handler still rejects image-generation models.

Both [Z-Image Turbo](https://ollama.com/x/z-image-turbo) and [FLUX.2 Klein](https://ollama.com/x/flux2-klein) retain macOS-only image-generation notes. Their model cards do not override the inspected release's behavior. Text completion and vision/image-input capabilities must not be used as evidence of generated image output.

## Consequence for this repository

The original requirement for `ollama/ollama:latest`, a Cloud Run NVIDIA L4, and real image output through Ollama itself cannot currently be completed with this published image. Existing Terraform can configure the private service and GPU, but loading a model or adding an adapter cannot create the missing runtime capability.

The Node Cloud Tasks service and lifecycle remain intact. A subsequent implementation added a gated native Ollama image adapter for fixed `x/z-image-turbo:fp8`, with private ID tokens, model digest/capability checks, validated PNG output and private storage. It does not change this runtime finding: both inspected container digests are refused and production activation remains blocked pending a compatible runtime and live evidence. See [the adapter guide](../../docs/ollama-image-generation.md). The separate vLLM-Omni proposal is not being implemented as a substitute.

A future supported Ollama release with actual image-output inference would need a fresh immutable digest, source/runtime capability check, pinned model installation lifecycle, and successful Linux/L4 image-to-private-storage verification. A custom or older experimental Ollama build would require a separate compatibility review and would change the stock-`latest` requirement; no such build is approved or implemented here.

No image layers/model weights were downloaded, no live inference was attempted, and no Terraform apply or GCP deployment was performed. This is a manifest/source finding, not a claim of executing the container.
