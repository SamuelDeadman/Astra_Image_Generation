import "server-only";
import { GoogleAuth } from "google-auth-library";
import { huggingFaceImageModel } from "@/lib/models/huggingface-image";
import { getHuggingFaceConfiguration, HuggingFaceImageError } from "./huggingface-image-config";
import { inspectImageBytes } from "./image-bytes";

const auth = new GoogleAuth();
export const maxHuggingFaceImageBytes = 16 * 1024 * 1024;
type Transport = { fetch?: typeof fetch; idTokenHeaders?: (audience: string) => Promise<Headers> };

export async function generateHuggingFaceImage(input: { modelId: string; prompt: string; timeoutSeconds: number }, hooks: { isCancelled(): Promise<boolean> }, transport: Transport = {}): Promise<Buffer> {
  const config = getHuggingFaceConfiguration();
  const model = huggingFaceImageModel(input.modelId);
  const prompt = input.prompt.trim();
  if (!model || !prompt || prompt.length > 20000 || !Number.isInteger(input.timeoutSeconds) || input.timeoutSeconds < 1 || input.timeoutSeconds > 1800) throw new HuggingFaceImageError("HF_INPUT_INVALID", "A reviewed model, bounded prompt and valid inference timeout are required.");
  const controller = new AbortController();
  let failure: HuggingFaceImageError | undefined;
  let poll: ReturnType<typeof setTimeout> | undefined;
  const abort = (error: HuggingFaceImageError) => { if (!controller.signal.aborted) { failure = error; controller.abort(); } };
  const timer = setTimeout(() => abort(new HuggingFaceImageError("HF_REQUEST_TIMEOUT", "Hugging Face inference exceeded its deadline.", true)), input.timeoutSeconds * 1000);
  const check = async () => {
    if (controller.signal.aborted) return;
    try { if (await hooks.isCancelled()) abort(new HuggingFaceImageError("GENERATION_CANCELLED", "Generation was cancelled.")); }
    catch { abort(new HuggingFaceImageError("HF_CANCELLATION_CHECK_FAILED", "Unable to confirm cancellation state.", true)); }
  };
  const monitor = async () => { await check(); if (!controller.signal.aborted) poll = setTimeout(() => { void monitor(); }, 1000); };
  let removeListener = () => {};
  const aborted = new Promise<never>((_, reject) => {
    const listener = () => reject(failure!);
    controller.signal.addEventListener("abort", listener, { once: true });
    removeListener = () => controller.signal.removeEventListener("abort", listener);
  });
  const operation = async () => {
    await monitor();
    controller.signal.throwIfAborted();
    let headers: Headers;
    try {
      headers = transport.idTokenHeaders ? await transport.idTokenHeaders(config.audience) : new Headers(await (await auth.getIdTokenClient(config.audience)).getRequestHeaders());
    } catch { throw new HuggingFaceImageError("HF_ID_TOKEN_UNAVAILABLE", "Unable to obtain the Hugging Face service ID token.", true); }
    controller.signal.throwIfAborted();
    if (!headers.get("authorization")?.startsWith("Bearer ")) throw new HuggingFaceImageError("HF_ID_TOKEN_UNAVAILABLE", "A Google-signed service ID token is required.");
    headers.set("Content-Type", "application/json");
    headers.set("Accept", "image/png");
    const response = await (transport.fetch ?? fetch)(config.serviceUrl + "/v1/images/generations", {
      method: "POST", redirect: "error", signal: controller.signal, headers,
      body: JSON.stringify({ model: model.id, revision: model.revision, catalogue_sha256: config.catalogueSha256, prompt, width: 1024, height: 1024, timeout_seconds: input.timeoutSeconds })
    });
    if (!response.ok) {
      await response.body?.cancel().catch(() => undefined);
      if (response.status === 401 || response.status === 403) throw new HuggingFaceImageError("HF_ACCESS_DENIED", "The Hugging Face service rejected the worker identity.");
      throw new HuggingFaceImageError("HF_REQUEST_FAILED", "The private Hugging Face inference request failed.", response.status === 429 || response.status >= 500);
    }
    const length = response.headers.get("content-length");
    if (response.headers.get("content-type")?.split(";", 1)[0] !== "image/png" || response.headers.get("x-model-id") !== model.id || response.headers.get("x-model-revision") !== model.revision || response.headers.get("x-model-catalogue-sha256") !== config.catalogueSha256 || (length && (!/^\d+$/.test(length) || Number(length) > maxHuggingFaceImageBytes)) || !response.body) {
      await response.body?.cancel().catch(() => undefined);
      throw new HuggingFaceImageError("HF_OUTPUT_INVALID", "Hugging Face returned an unexpected model pin or image contract.");
    }
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let size = 0;
    try {
      while (true) {
        controller.signal.throwIfAborted();
        const next = await reader.read();
        if (next.done) break;
        size += next.value.byteLength;
        if (size > maxHuggingFaceImageBytes) throw new HuggingFaceImageError("HF_OUTPUT_TOO_LARGE", "Hugging Face image exceeded the output limit.");
        chunks.push(next.value);
      }
    } finally { await reader.cancel().catch(() => undefined); reader.releaseLock(); }
    const bytes = Buffer.concat(chunks, size);
    try {
      const info = await inspectImageBytes(bytes, 1024 * 1024);
      if (info.contentType !== "image/png" || info.width !== 1024 || info.height !== 1024) throw new Error("dimensions");
    } catch { throw new HuggingFaceImageError("HF_OUTPUT_INVALID", "Hugging Face returned corrupt or unsupported image bytes."); }
    await check();
    controller.signal.throwIfAborted();
    return bytes;
  };
  try { return await Promise.race([operation(), aborted]); }
  catch (error) {
    if (failure) throw failure;
    if (error instanceof HuggingFaceImageError) throw error;
    throw new HuggingFaceImageError("HF_UNAVAILABLE", "The private Hugging Face image runtime is unavailable.", true);
  } finally { clearTimeout(timer); clearTimeout(poll); removeListener(); controller.abort(); }
}
