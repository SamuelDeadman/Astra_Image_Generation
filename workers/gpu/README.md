# Private L4 Ollama worker

The selected fixed model is **`x/flux2-klein:4b-fp8`**, catalogue ID `ollama-flux2-klein-4b-fp8`. GCP hosted worker selects this route; other user-facing inference solutions and new BYOK credentials are disabled.

See [the complete cache and deployment guide](../../docs/ollama-model-cache.md). It covers the private regional GCS model bucket, checksum-verified CPU preparation job, read-only FUSE mount, staged activation and offline tests.

Cloud Tasks targets the separate private Node generation service. Node validates authoritative plans, obtains an Ollama-specific ID token and calls native Ollama image APIs. Ollama never receives the task endpoint or application database/KMS credentials. It receives read-only access only to its model cache. The Node worker continues to save validated generated images in the separate private output bucket.

The GPU service retains scale-to-zero, concurrency one, one L4 when enabled, and process probes at `/api/version`. Those probes do not establish image-generation readiness. Cached weights survive instance replacement; cold instances read them from GCS before GPU inference.

The FLUX.2 Klein model page still marks image generation as macOS-only, and the inspected stock Linux Ollama runtime rejects image generation. The configured model, API integration and cache do not remove that blocker. Known incompatible image digests remain rejected; a compatible immutable runtime and real L4-to-private-storage verification are required before normal generation can be enabled.

The earlier Z-Image and alternative-runtime documents in this directory are historical investigations, not the current selected deployment. No model weights were downloaded and no GCP deployment was performed by this implementation.
