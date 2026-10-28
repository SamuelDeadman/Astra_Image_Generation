import "server-only";
import { GoogleAuth } from "google-auth-library";
import { z } from "zod";
import { ollamaImageHeight, ollamaImageModelReference, ollamaImageWidth } from "@/lib/models/ollama-image";
import { inspectImageBytes } from "./image-bytes";
import { getOllamaImageConfiguration, OllamaImageError } from "./ollama-image-config";

const auth = new GoogleAuth();
export const maxOllamaImageBytes = 16 * 1024 * 1024;
const maxEncodedImageLength = Math.ceil(maxOllamaImageBytes / 3) * 4;
const maxImageResponseBytes = maxEncodedImageLength + 64 * 1024;
const maxMetadataBytes = 1024 * 1024;
const pollIntervalMs = 1000;

const imageResponse = z.object({
  model: z.literal(ollamaImageModelReference),
  done: z.literal(true),
  image: z.string().min(1).max(maxEncodedImageLength),
  response: z.string().max(0).optional(),
  remote_model: z.string().max(0).optional(),
  remote_host: z.string().max(0).optional(),
  error: z.never().optional()
});

// Injectable transport/auth only for tests and operator tooling, never workflow fields.
type Transport = {
  fetch?: typeof fetch;
  idTokenHeaders?: (audience: string) => Promise<Headers>;
};
async function idTokenHeaders(audience: string) {
  const client = await auth.getIdTokenClient(audience);
  return new Headers(await client.getRequestHeaders());
}

async function boundedJson(response: Response, limit: number, signal: AbortSignal) {
  const type = response.headers.get("content-type")?.split(";", 1)[0].trim().toLowerCase();
  if (type !== "application/json") throw new OllamaImageError("OLLAMA_OUTPUT_INVALID", "Ollama did not return the expected JSON image contract.");
  const declaredLength = response.headers.get("content-length");
  if (declaredLength && (!/^\d+$/.test(declaredLength) || Number(declaredLength) > limit)) {
    throw new OllamaImageError("OLLAMA_OUTPUT_TOO_LARGE", "Ollama returned an oversized response.");
  }
  if (!response.body) throw new OllamaImageError("OLLAMA_OUTPUT_INVALID", "Ollama returned an empty response.");
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      signal.throwIfAborted();
      const chunk = await reader.read();
      if (chunk.done) break;
      size += chunk.value.byteLength;
      if (size > limit) throw new OllamaImageError("OLLAMA_OUTPUT_TOO_LARGE", "Ollama returned an oversized response.");
      chunks.push(chunk.value);
    }
    signal.throwIfAborted();
    try { return JSON.parse(Buffer.concat(chunks, size).toString("utf8")) as unknown; }
    catch { throw new OllamaImageError("OLLAMA_OUTPUT_INVALID", "Ollama returned malformed JSON."); }
  } finally {
    // Cancel on partial/invalid responses; fetch itself is also aborted by the request scope.
    await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}

function responseFailure(status: number): OllamaImageError {
  if (status === 401 || status === 403) return new OllamaImageError("OLLAMA_ACCESS_DENIED", "Ollama rejected the worker identity. Check service IAM, internal routing and the ID-token audience.");
  if (status === 400 || status === 404 || status === 422) return new OllamaImageError("OLLAMA_IMAGE_RUNTIME_UNSUPPORTED", "The Ollama runtime or installed model does not support the required image-generation contract.");
  if (status === 429) return new OllamaImageError("OLLAMA_CAPACITY_EXCEEDED", "Ollama image-generation capacity is temporarily exhausted.", true);
  return new OllamaImageError("OLLAMA_REQUEST_FAILED", "The private Ollama image-generation request failed.", status >= 500);
}

export async function generateOllamaImage(
  input: { prompt: string; timeoutSeconds: number },
  hooks: { isCancelled(): Promise<boolean> },
  transport: Transport = {}
): Promise<Buffer> {
  const config = getOllamaImageConfiguration();
  const prompt = input.prompt.trim();
  if (!prompt || prompt.length > 20000 || !Number.isInteger(input.timeoutSeconds) || input.timeoutSeconds < 1 || input.timeoutSeconds > 1800) {
    throw new OllamaImageError("OLLAMA_INPUT_INVALID", "Ollama requires a bounded, nonempty text prompt and a valid worker timeout.");
  }
  const controller = new AbortController();
  const { signal } = controller;
  let abortFailure: OllamaImageError | undefined;
  let cancellationTimer: ReturnType<typeof setTimeout> | undefined;
  const abort = (error: OllamaImageError) => {
    if (!signal.aborted) { abortFailure = error; controller.abort(); }
  };
  const timeout = setTimeout(() => abort(new OllamaImageError("OLLAMA_REQUEST_TIMEOUT", "Ollama image generation exceeded the request deadline.", true)), input.timeoutSeconds * 1000);
  const checkCancellation = async () => {
    if (signal.aborted) return;
    try {
      if (await hooks.isCancelled()) abort(new OllamaImageError("GENERATION_CANCELLED", "Generation was cancelled."));
    } catch {
      abort(new OllamaImageError("OLLAMA_CANCELLATION_CHECK_FAILED", "The worker could not confirm generation cancellation state.", true));
    }
  };
  const pollCancellation = async () => {
    await checkCancellation();
    if (!signal.aborted) cancellationTimer = setTimeout(() => { void pollCancellation(); }, pollIntervalMs);
  };
  let removeAbortListener = () => undefined as void;
  const aborted = new Promise<never>((_resolve, reject) => {
    const listener = () => reject(abortFailure!);
    signal.addEventListener("abort", listener, { once: true });
    removeAbortListener = () => signal.removeEventListener("abort", listener);
  });
  const operation = async () => {
    await pollCancellation();
    signal.throwIfAborted();
    let headers: Headers;
    try { headers = await (transport.idTokenHeaders ?? idTokenHeaders)(config.audience); }
    catch { throw new OllamaImageError("OLLAMA_ID_TOKEN_UNAVAILABLE", "The worker could not obtain a Google-signed Ollama ID token.", true); }
    signal.throwIfAborted();
    if (!headers.get("authorization")?.startsWith("Bearer ")) throw new OllamaImageError("OLLAMA_ID_TOKEN_UNAVAILABLE", "The worker could not obtain a Google-signed Ollama ID token.", true);
    headers.set("Content-Type", "application/json");
    headers.set("Accept", "application/json");
    const request = async (pathname: string, body?: unknown, limit = maxMetadataBytes) => {
      signal.throwIfAborted();
      const response = await (transport.fetch ?? fetch)(config.serviceUrl + pathname, {
        method: body === undefined ? "GET" : "POST",
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
        redirect: "error",
        signal
      });
      if (!response.ok) {
        await response.body?.cancel().catch(() => undefined);
        throw responseFailure(response.status);
      }
      return boundedJson(response, limit, signal);
    };
    // Recheck the installed tag's immutable digest on each attempt; never pull or trust a tag alone.
    const tags = z.object({ models: z.array(z.object({
      name: z.string(),
      // Native /api/tags returns bare SHA-256 hex; configuration uses OCI-style pins.
      digest: z.string().regex(/^(?:sha256:)?[a-f0-9]{64}$/)
        .transform((value) => value.startsWith("sha256:") ? value : `sha256:${value}`)
    })).max(1000) })
      .safeParse(await request("/api/tags"));
    const model = tags.success && tags.data.models.find((entry) => entry.name === ollamaImageModelReference);
    if (!model || model.digest !== config.modelDigest) throw new OllamaImageError("OLLAMA_MODEL_PIN_MISMATCH", "The required Ollama model is missing or its installed digest differs from the reviewed pin.");
    const show = z.object({ capabilities: z.array(z.string()).max(100), remote_model: z.string().max(0).optional(), remote_host: z.string().max(0).optional() })
      .safeParse(await request("/api/show", { model: ollamaImageModelReference }));
    if (!show.success || !show.data.capabilities.includes("image")) throw new OllamaImageError("OLLAMA_IMAGE_RUNTIME_UNSUPPORTED", "The installed Ollama model does not advertise image output.");
    const parsed = imageResponse.safeParse(await request("/api/generate", {
      model: ollamaImageModelReference,
      prompt,
      stream: false,
      width: ollamaImageWidth,
      height: ollamaImageHeight
    }, maxImageResponseBytes));
    // A repeated-group base64 regex can overflow the RegExp stack on multi-megabyte images.
    // Scan the alphabet linearly, then enforce padding/canonical encoding with a round trip.
    if (!parsed.success || parsed.data.image.length % 4 !== 0 || /[^A-Za-z0-9+/=]/.test(parsed.data.image)) {
      throw new OllamaImageError("OLLAMA_OUTPUT_INVALID", "Ollama returned no valid completed image output.");
    }
    const bytes = Buffer.from(parsed.data.image, "base64");
    if (!bytes.length || bytes.length > maxOllamaImageBytes || bytes.toString("base64") !== parsed.data.image) {
      throw new OllamaImageError("OLLAMA_OUTPUT_INVALID", "Ollama returned invalid encoded image bytes.");
    }
    let actual: Awaited<ReturnType<typeof inspectImageBytes>>;
    try { actual = await inspectImageBytes(bytes, ollamaImageWidth * ollamaImageHeight); }
    catch { throw new OllamaImageError("OLLAMA_OUTPUT_INVALID", "Ollama returned corrupt or unsupported image bytes."); }
    if (actual.contentType !== "image/png" || actual.width !== ollamaImageWidth || actual.height !== ollamaImageHeight) {
      throw new OllamaImageError("OLLAMA_OUTPUT_INVALID", "Ollama returned an image with unexpected format or dimensions.");
    }
    await checkCancellation();
    signal.throwIfAborted();
    return bytes;
  };
  try { return await Promise.race([operation(), aborted]); }
  catch (error) {
    if (abortFailure) throw abortFailure;
    if (error instanceof OllamaImageError) throw error;
    throw new OllamaImageError("OLLAMA_UNAVAILABLE", "The private Ollama image runtime is unavailable.", true);
  } finally {
    clearTimeout(timeout);
    clearTimeout(cancellationTimer);
    removeAbortListener();
    // Also stop any in-flight transport if parsing/validation exited early.
    controller.abort();
  }
}
