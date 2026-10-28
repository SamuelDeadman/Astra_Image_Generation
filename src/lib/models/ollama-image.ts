// Code-owned identities. Workflows cannot select an Ollama URL, model or pull source.
export const ollamaImageModelId = "ollama-flux2-klein-4b-fp8";
export const ollamaImageModelReference = "x/flux2-klein:4b-fp8";
export const ollamaImageModelDigest = "sha256:d968d763271aa912ac5499320d349bf4cb75267d7fbf499203bb8e8f19dde6ef";
export const ollamaImageProviderId = "astraflow-ollama";
export const ollamaImageAdapterRevision = "ollama-image-v2";
export const ollamaImageWidth = 1024;
export const ollamaImageHeight = 1024;

// The inspected release rejects all image-generation models. A flag cannot verify it.
export const unsupportedOllamaImageDigests = new Set([
  "sha256:265409e1d931028a8f7d5a32bcbafddd7bffbc6cc629d77efe9560adf692a5e7",
  "sha256:40c61dbf5091e0b4cc46f406f912fb061cfeca51208f0f7173c87c3b5f795c95"
]);
