# Selected model: Z-Image Turbo FP8

Historical selection, superseded by `x/flux2-klein:4b-fp8`. See [the current model-cache and deployment guide](../../docs/ollama-model-cache.md).

The requested exact Ollama reference is **`x/z-image-turbo:fp8`**. Keep both the `x/` namespace and the explicit `:fp8` tag; do not substitute the unqualified name, `:latest` or `:bf16`.

Selection is recorded in [Terraform operator metadata](../../terraform/ollama-model-selection.json) and exposed through operator outputs. A gated candidate catalogue entry and native image adapter now hardcode this reference. The candidate is hidden while the feature is disabled and seeded disabled when opted in; normal generation requires current live deployment verification. See [the adapter guide](../../docs/ollama-image-generation.md). Review metadata does not install or activate weights.

## Current platform blocker

Checked 20 October 2026: a release-specific source/manifest check found that the current `ollama/ollama:latest` matches `0.40.6`, whose generation handler explicitly rejects image-generation models with HTTP 400. This affects the image capability generally, so changing model names does not bypass it. See [the published-image support finding](ollama-image-support.md) for the digest and official source.

The [official model card](https://ollama.com/x/z-image-turbo) still describes macOS-only experimental image support. That older model-card description is not sufficient evidence for the current published container; general CUDA/MLX support does not establish image output.

The requested model is selected, but it is **not installed, loaded or enabled** on Cloud Run. No image-generation result has been verified. An automatic pull or an `ollama run` startup command would not resolve the platform blocker. The private Ollama service continues to start `ollama serve`; Cloud Tasks continues to target the separate Node lifecycle worker.

The earlier requested [runtime investigation](linux-runtime-investigation.md) identified vLLM-Omni as an alternative candidate. The latest instruction requires Ollama itself, so that alternative is not being implemented as a substitute. No production image runtime has been activated.

## Exact command and prompting preferences

For a separately managed, supported macOS installation, the requested interactive command is:

```sh
ollama run x/z-image-turbo:fp8
```

This command was not executed here. It may download model weights, and does not configure a Cloud Run server, private output storage or an AstraFlow adapter.

For later verification, preserve the user's preferences:

- Start at **1024 x 1024**, as recommended by the model card; this is a target for testing, not a verified AstraFlow capability.
- Describe the subject, setting, lighting, composition, materials and visual style in detail.
- Put desired image lettering in quotes, and describe its font/style and position.
- Start with photorealistic scenes when assessing output quality.

Example prompt: A photorealistic bakery storefront at sunrise, warm light on textured stone, a dark green sign above the doorway with the exact text "MORNING LOAF" in centered cream serif letters, realistic reflections, natural perspective.

## Requirements before Linux/L4 activation

1. Verify official Linux/CUDA support for this exact model in a specific Ollama build, or validate the investigated vLLM-Omni candidate against the original checkpoint. No alternative runtime is activated by this record.
2. Resolve the mutable model tag to its manifest and weight checksums and pin the tested container digest. The model tag is not an immutable model pin; `manifest_digest=null` records that no approved pin exists yet.
3. Test actual peak RAM/VRAM, loading time, 1024-square output and GPU use on Linux/L4. The model card's roughly 13 GB weight listing is not a peak-memory requirement; do not infer that the current 16Gi instance configuration is sufficient.
4. Implement deterministic installation/cache restoration, failure handling and separate model-readiness checks. Cloud Run local files remain ephemeral; no persistent model lifecycle exists yet.
5. Implement the reviewed private Node-to-inference contract with the correct ID-token identity/audience, bounded image decoding and private asset upload, then pass stored-image verification before catalogue activation.

Until then, startup downloads stay absent and normal generation remains unavailable. No live cloud deployment, model download or paid operation was performed for this selection or adapter implementation.
