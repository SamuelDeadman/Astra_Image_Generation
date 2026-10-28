import assert from "node:assert/strict";
import crypto from "node:crypto";
import Module from "node:module";
import path from "node:path";
import test, { after, before } from "node:test";
import sharp from "sharp";
import { getModelById } from "../src/lib/models/catalog";
import { ollamaImageModelId, ollamaImageModelReference, ollamaImageModelDigest, unsupportedOllamaImageDigests } from "../src/lib/models/ollama-image";
import { applyConfirmedModelDefaults, previewModelDefaults } from "../src/lib/models/constraints";
import { baseTextToImageWorkflow } from "../src/lib/workflow/templates";
import { validateWorkflow } from "../src/lib/workflow/schema";
import type { StepExecutionContext } from "../src/server/generations/inference-adapters";

const loader = Module as unknown as { _load(request: string, parent: unknown, isMain: boolean): unknown };
const originalLoad = loader._load;
const requireTest = Module.createRequire(path.join(process.cwd(), "tests", "ollama-image-generation.test.ts"));
const configValues = {
  serviceUrl: "https://private-ollama-123.run.app",
  audience: "https://run.googleapis.com/projects/test/services/private-ollama/ollama",
  containerDigest: "sha256:" + "b".repeat(64),
  modelDigest: ollamaImageModelDigest
};
const authenticatedAudiences: string[] = [];
const writes: Array<{ bucket: string; objectPath: string; contentType: string; data: Buffer }> = [];
loader._load = function(request, parent, isMain) {
  if (request === "server-only") return {};
  if (request === "google-auth-library") return { GoogleAuth: class {
    async getIdTokenClient(audience: string) {
      authenticatedAudiences.push(audience);
      return { getRequestHeaders: async () => new Headers({ authorization: "Bearer test-only-id-token" }) };
    }
    async getAccessToken() { throw new Error("An access token must never authenticate Ollama."); }
  } };
  if (request === "@/server/gcp/storage") return { writePrivateObject: async (input: (typeof writes)[number]) => {
    writes.push(input);
    return { sizeBytes: input.data.length, sha256: crypto.createHash("sha256").update(input.data).digest("hex") };
  } };
  return originalLoad.call(this, request.startsWith("@/") ? path.join(process.cwd(), "src", request.slice(2)) : request, parent, isMain);
};
const config = requireTest("../src/server/generations/ollama-image-config") as typeof import("../src/server/generations/ollama-image-config");
const client = requireTest("../src/server/generations/ollama-image-client") as typeof import("../src/server/generations/ollama-image-client");
const adapters = requireTest("../src/server/generations/inference-adapters") as typeof import("../src/server/generations/inference-adapters");
const policy = requireTest("../src/server/models/policy") as typeof import("../src/server/models/policy");
const compiler = requireTest("../src/server/workflows/compiler") as typeof import("../src/server/workflows/compiler");
const env = {
  NODE_ENV: "test" as const,
  OLLAMA_IMAGE_GENERATION_ENABLED: "true",
  OLLAMA_MODEL_CACHE_READY: "true",
  OLLAMA_CONTAINER_DIGEST: configValues.containerDigest,
  OLLAMA_MODEL_DIGEST: configValues.modelDigest,
  OLLAMA_SERVICE_URL: configValues.serviceUrl,
  OLLAMA_AUDIENCE: configValues.audience,
  OLLAMA_DEPLOYMENT_FINGERPRINT: config.ollamaDeploymentFingerprint(configValues),
  ASTRAFLOW_RUNTIME_ROLE: "worker",
  WORKER_AUDIENCE: "https://tasks-only.example",
  GCS_OUTPUT_BUCKET: "private-output"
};
const previousEnv = Object.fromEntries(Object.keys(env).map((key) => [key, process.env[key]]));
Object.assign(process.env, env);
const previousFetch = globalThis.fetch;
let png: Buffer;
before(async () => { png = await sharp({ create: { width: 1024, height: 1024, channels: 3, background: "blue" } }).png().toBuffer(); });
after(() => {
  loader._load = originalLoad;
  globalThis.fetch = previousFetch;
  for (const [key, value] of Object.entries(previousEnv)) {
    if (value === undefined) delete process.env[key]; else process.env[key] = value;
  }
});
const hooks = { isCancelled: async () => false };
const input = { prompt: 'A cinema photograph of a cafe, a sign reading "OPEN" above the door.', timeoutSeconds: 10 };
type Call = { url: string; init: RequestInit; body: Record<string, unknown> | undefined };
function transport(generate?: (call: Call) => Response | Promise<Response>, tags?: unknown, show?: unknown) {
  const calls: Call[] = [];
  const fetch: typeof globalThis.fetch = async (url, init) => {
    const call = { url: String(url), init: init!, body: init?.body ? JSON.parse(String(init.body)) as Record<string, unknown> : undefined };
    calls.push(call);
    if (call.url.endsWith("/api/tags")) return Response.json(tags ?? { models: [{ name: ollamaImageModelReference, digest: configValues.modelDigest.slice(7) }] });
    if (call.url.endsWith("/api/show")) return Response.json(show ?? { capabilities: ["image"] });
    assert.equal(call.url, configValues.serviceUrl + "/api/generate");
    return generate ? generate(call) : Response.json({ model: ollamaImageModelReference, done: true, response: "", image: png.toString("base64") });
  };
  return { calls, fetch };
}
function hasCode(code: string, retryable = false) {
  return (error: unknown) => {
    assert(error instanceof config.OllamaImageError);
    assert.equal(error.code, code);
    assert.equal(error.retryable, retryable);
    return true;
  };
}
function contextForModel(): StepExecutionContext {
  const model = getModelById(ollamaImageModelId)!;
  const base = structuredClone(baseTextToImageWorkflow);
  base.selectedModel = model.id;
  base.executionEnvironment = "gcp-hosted";
  const workflow = applyConfirmedModelDefaults(base, previewModelDefaults(base, model), true);
  const node = workflow.nodes.find((entry) => entry.type === "text-to-image")!;
  return {
    job: { _id: "job_123", ownerId: "owner_123", workflowRevisionId: "revision_123" },
    workflowRevision: { _id: "revision_123", workflow }, executionPlan: { planHash: "hash" },
    step: { id: "step_image", nodeId: node.id, nodeType: "text-to-image", modelId: model.id, providerId: model.providerId,
      pinnedModelVersion: model.providerModelId, route: model.route, adapterId: model.route, parameters: { ...node.data, prompt: "Studio lighting." },
      estimates: { credits: 6 }, timeoutSeconds: 10 },
    inputs: { prompt: { type: "text", text: input.prompt }, dimensions: { type: "dimensions", width: 1024, height: 1024, batch: 1 } },
    attemptId: "attempt_123"
  } as unknown as StepExecutionContext;
}

test("native image calls use a distinct Google ID token, fixed URL/model and bounded payload", async () => {
  const remote = transport();
  const bytes = await client.generateOllamaImage(input, hooks, remote);
  assert.deepEqual(bytes, png);
  assert.equal(authenticatedAudiences.at(-1), configValues.audience);
  assert.deepEqual(remote.calls.map((call) => new URL(call.url).pathname), ["/api/tags", "/api/show", "/api/generate"]);
  for (const call of remote.calls) {
    assert.equal(call.init.redirect, "error");
    assert.equal(new Headers(call.init.headers).get("authorization"), "Bearer test-only-id-token");
    assert.equal(call.init.signal?.aborted, true); // Transport is closed on completion too.
  }
  assert.equal(remote.calls[0].init.method, "GET");
  assert.deepEqual(remote.calls[1].body, { model: ollamaImageModelReference });
  assert.deepEqual(remote.calls[2].body, { model: ollamaImageModelReference, prompt: input.prompt, stream: false, width: 1024, height: 1024 });
});

test("missing/replaced models and models without image capability never reach generation", async () => {
  for (const tags of [{ models: [] }, { models: [{ name: ollamaImageModelReference, digest: "sha256:" + "c".repeat(64) }] }]) {
    const remote = transport(undefined, tags);
    await assert.rejects(client.generateOllamaImage(input, hooks, remote), hasCode("OLLAMA_MODEL_PIN_MISMATCH"));
    assert.equal(remote.calls.length, 1);
  }
  for (const show of [{ capabilities: ["completion", "vision"] }, { capabilities: ["image"], remote_host: "https://remote.example" }]) {
    const remote = transport(undefined, undefined, show);
    await assert.rejects(client.generateOllamaImage(input, hooks, remote), hasCode("OLLAMA_IMAGE_RUNTIME_UNSUPPORTED"));
    assert.equal(remote.calls.length, 2);
  }
});

test("text responses, unfinished/wrong-model/remote responses and malformed base64 fail closed", async () => {
  const valid = { model: ollamaImageModelReference, done: true, image: png.toString("base64") };
  for (const response of [
    { model: ollamaImageModelReference, done: true, response: "Here is your image" },
    { ...valid, done: false }, { ...valid, model: "llama3" }, { ...valid, image: "%%%" },
    { ...valid, image: "AAAA====" }, { ...valid, remote_host: "https://remote.example" },
    { ...valid, response: "unexpected text" }, { ...valid, error: "do not expose this" }
  ]) {
    await assert.rejects(client.generateOllamaImage(input, hooks, transport(() => Response.json(response))), hasCode("OLLAMA_OUTPUT_INVALID"));
  }
});

test("image bytes must fully decode as exactly one 1024 square PNG", async () => {
  const wrongSize = await sharp(png).resize(512, 512).png().toBuffer();
  const jpeg = await sharp(png).jpeg().toBuffer();
  for (const bytes of [Buffer.from("text"), png.subarray(0, 48), wrongSize, jpeg]) {
    await assert.rejects(client.generateOllamaImage(input, hooks, transport(() => Response.json({ model: ollamaImageModelReference, done: true, image: bytes.toString("base64") }))), hasCode("OLLAMA_OUTPUT_INVALID"));
  }
});

test("multi-megabyte PNG output remains valid without a repeated-group base64 regex", async () => {
  const bytes = await sharp(crypto.randomBytes(1024 * 1024 * 3), { raw: { width: 1024, height: 1024, channels: 3 } }).png().toBuffer();
  assert(bytes.length > 3 * 1024 * 1024);
  const actual = await client.generateOllamaImage(input, hooks, transport(() => Response.json({ model: ollamaImageModelReference, done: true, image: bytes.toString("base64") })));
  assert.deepEqual(actual, bytes);
});

test("malformed JSON/content type and declared or streamed oversized responses are rejected", async () => {
  for (const response of [new Response("{", { headers: { "content-type": "application/json" } }), new Response("plain text")]) {
    await assert.rejects(client.generateOllamaImage(input, hooks, transport(() => response)), hasCode("OLLAMA_OUTPUT_INVALID"));
  }
  const tooLarge = new Response("{}", { headers: { "content-type": "application/json", "content-length": String(30 * 1024 * 1024) } });
  await assert.rejects(client.generateOllamaImage(input, hooks, transport(() => tooLarge)), hasCode("OLLAMA_OUTPUT_TOO_LARGE"));
  let cancelled = false;
  const body = new ReadableStream<Uint8Array>({ pull(controller) { controller.enqueue(new Uint8Array(1024 * 1024)); }, cancel() { cancelled = true; } });
  await assert.rejects(client.generateOllamaImage(input, hooks, transport(() => new Response(body, { headers: { "content-type": "application/json" } }))), hasCode("OLLAMA_OUTPUT_TOO_LARGE"));
  assert.equal(cancelled, true);
});

test("HTTP failures expose safe errors and only temporary failures are retryable", async () => {
  for (const [status, code, retryable] of [[403, "OLLAMA_ACCESS_DENIED", false], [400, "OLLAMA_IMAGE_RUNTIME_UNSUPPORTED", false], [429, "OLLAMA_CAPACITY_EXCEEDED", true], [503, "OLLAMA_REQUEST_FAILED", true]] as const) {
    await assert.rejects(client.generateOllamaImage(input, hooks, transport(() => new Response("secret provider details", { status }))), (error: unknown) => {
      hasCode(code, retryable)(error);
      assert(!String(error).includes("secret provider details"));
      return true;
    });
  }
  await assert.rejects(client.generateOllamaImage(input, hooks, transport(() => { throw new Error("token secret and internal hostname"); })), hasCode("OLLAMA_UNAVAILABLE", true));
});

test("missing ID-token authentication and unbounded prompts produce no inference call", async () => {
  const remote = transport();
  await assert.rejects(client.generateOllamaImage(input, hooks, { ...remote, idTokenHeaders: async () => new Headers() }), hasCode("OLLAMA_ID_TOKEN_UNAVAILABLE", true));
  assert.equal(remote.calls.length, 0);
  for (const prompt of [" ", "a".repeat(20001)]) await assert.rejects(client.generateOllamaImage({ ...input, prompt }, hooks, remote), hasCode("OLLAMA_INPUT_INVALID"));
  assert.equal(remote.calls.length, 0);
});

test("cancellation aborts in-flight HTTP and deadlines cover stalled authentication too", async () => {
  let cancelled = false;
  const remote = transport((call) => new Promise((_resolve, reject) => {
    cancelled = true;
    call.init.signal!.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
  }));
  await assert.rejects(client.generateOllamaImage(input, { isCancelled: async () => cancelled }, remote), hasCode("GENERATION_CANCELLED"));
  assert.equal(remote.calls.at(-1)!.init.signal!.aborted, true);
  const stalled = transport();
  await assert.rejects(client.generateOllamaImage({ ...input, timeoutSeconds: 1 }, hooks, { ...stalled, idTokenHeaders: () => new Promise(() => undefined) }), hasCode("OLLAMA_REQUEST_TIMEOUT", true));
  assert.equal(stalled.calls.length, 0);
  await assert.rejects(client.generateOllamaImage(input, { isCancelled: async () => { throw new Error("database offline"); } }, transport()), hasCode("OLLAMA_CANCELLATION_CHECK_FAILED", true));
});

test("configuration rejects arbitrary endpoints, mismatched fingerprints, shared audiences and known unsupported images", () => {
  assert.deepEqual(config.getOllamaImageConfiguration(env), configValues);
  assert.throws(() => config.getOllamaImageConfiguration({ ...env, OLLAMA_MODEL_CACHE_READY: "false" }), /verified FLUX/);
  assert.throws(() => config.getOllamaImageConfiguration({ ...env, OLLAMA_MODEL_DIGEST: "sha256:" + "f".repeat(64) }), /verified FLUX/);
  for (const url of ["http://private.run.app", "https://attacker.example", "https://private.run.app/path", "https://user:pass@private.run.app", "https://private.run.app?x=1"]) assert.throws(() => config.getOllamaImageConfiguration({ ...env, OLLAMA_SERVICE_URL: url }));
  assert.throws(() => config.getOllamaImageConfiguration({ ...env, OLLAMA_AUDIENCE: env.WORKER_AUDIENCE }));
  assert.throws(() => config.getOllamaImageConfiguration({ ...env, OLLAMA_DEPLOYMENT_FINGERPRINT: "c".repeat(64) }));
  for (const digest of unsupportedOllamaImageDigests) assert.throws(() => config.getOllamaImageConfiguration({ ...env, OLLAMA_CONTAINER_DIGEST: digest }), /rejects image generation/);
  assert.throws(() => config.assertOllamaImageConfigured({ ...env, OLLAMA_IMAGE_GENERATION_ENABLED: "false" }), /no reviewed model runtime/);
  assert.doesNotThrow(() => config.assertOllamaImageConfigured({ ...env, ASTRAFLOW_RUNTIME_ROLE: "web", OLLAMA_SERVICE_URL: undefined, OLLAMA_AUDIENCE: undefined }));
});

test("validated workflow reaches Ollama and creates an owner/job/attempt-bound private image artifact", async () => {
  const context = contextForModel();
  const definition = getModelById(ollamaImageModelId)!;
  const imageNode = context.workflowRevision.workflow.nodes.find((node) => node.type === "text-to-image")!;
  const promptNode = context.workflowRevision.workflow.nodes.find((node) => node.type === "prompt-input")!;
  if (imageNode.type === "text-to-image") imageNode.data.prompt = "Studio lighting.";
  if (promptNode.type === "prompt-input") promptNode.data.prompt = input.prompt;
  assert.equal(validateWorkflow(context.workflowRevision.workflow).ok, true);
  context.executionPlan = compiler.compileWorkflowExecutionPlan({
    ownerId: context.job.ownerId, workflowId: "workflow_123", workflowRevisionId: "revision_123",
    workflow: context.workflowRevision.workflow,
    models: [{ id: definition.id, displayName: definition.name, providerId: definition.providerId,
      provider: { id: definition.providerId, route: definition.route }, route: definition.route,
      isEnabled: true, maxPixels: 1024 * 1024, maxSteps: 0, baseCreditCost: 6,
      capabilities: definition.capabilities, pinnedVersion: definition.providerModelId
    } as import("../src/server/models/models").EnabledModelRecord]
  });
  context.step = context.executionPlan.steps.find((step) => step.nodeType === "text-to-image")!;
  assert.equal(context.step.adapterId, "gcp-hosted-gpu");
  assert.equal(context.step.pinnedModelVersion, ollamaImageModelReference);
  // Use the compiler's constants, as the worker does after authoritative reload.
  context.inputs.prompt = { type: "text", text: String(context.step.inputPorts.prompt.value) };
  context.inputs.dimensions = { type: "dimensions", ...context.step.inputPorts.dimensions.value as { width: number; height: number; batch: number } };
  const remote = transport();
  globalThis.fetch = remote.fetch;
  writes.length = 0;
  const progress: string[] = [];
  const result = await adapters.getStepExecutionAdapter("gcp-hosted-gpu").execute(context, { ...hooks, progress: async (event) => { if (event.type === "progress") progress.push(event.status); } });
  assert.equal(writes.length, 1);
  assert.equal(writes[0].bucket, "private-output");
  assert.match(writes[0].objectPath, /^outputs\/[a-f0-9]+\/job_123\/attempt_123\/step_image_model\.png$/);
  assert.deepEqual(writes[0].data, png);
  assert.equal(remote.calls.at(-1)!.body!.prompt, "Studio lighting.\n\n" + input.prompt);
  assert.deepEqual(progress, ["GENERATING", "UPLOADING"]);
  assert.equal(result.actualCredits, context.step.estimates.credits);
  assert.equal(result.outputs.image.type, "image");
  if (result.outputs.image.type === "image") {
    assert.equal(result.outputs.image.artifact!.sha256, crypto.createHash("sha256").update(png).digest("hex"));
    assert.equal(result.outputs.image.width, 1024);
    assert.equal(result.outputs.image.contentType, "image/png");
  }
});

test("adapter refuses tampered model/parameters/input handles and cancelled work without storing output", async () => {
  const remote = transport(); globalThis.fetch = remote.fetch; writes.length = 0;
  const adapter = adapters.getStepExecutionAdapterRegistration("gcp-hosted-gpu").adapter;
  const wrongModel = contextForModel(); wrongModel.step.pinnedModelVersion = "other-model";
  const wrongSize = contextForModel(); wrongSize.inputs.dimensions = { type: "dimensions", width: 512, height: 512, batch: 1 };
  const wrongSeed = contextForModel(); wrongSeed.step.parameters.seed = 12;
  const wrongHandle = contextForModel(); wrongHandle.inputs.url = { type: "text", text: "https://attacker.example" };
  for (const context of [wrongModel, wrongSize, wrongSeed, wrongHandle]) await assert.rejects(adapter.execute(context, { ...hooks, progress: async () => undefined }));
  await assert.rejects(adapter.execute(contextForModel(), { isCancelled: async () => true, progress: async () => undefined }));
  assert.equal(remote.calls.length, 0); assert.equal(writes.length, 0);
  globalThis.fetch = transport(() => Response.json({ response: "text only" })).fetch;
  await assert.rejects(adapter.execute(contextForModel(), { ...hooks, progress: async () => undefined }), (error: unknown) => {
    assert(error instanceof adapters.GenerationInferenceFailure); assert.equal(error.code, "OLLAMA_OUTPUT_INVALID"); return true;
  });
  assert.equal(writes.length, 0);
  const flag = process.env.OLLAMA_IMAGE_GENERATION_ENABLED;
  process.env.OLLAMA_IMAGE_GENERATION_ENABLED = "false";
  try {
    await assert.rejects(adapter.execute(contextForModel(), { ...hooks, progress: async () => undefined }), /no reviewed model runtime/);
  } finally { process.env.OLLAMA_IMAGE_GENERATION_ENABLED = flag; }
});

test("live model evidence is invalidated when any Ollama deployment pin or origin changes", () => {
  const model = getModelById(ollamaImageModelId)!;
  const original = policy.modelConfigurationFingerprint(model, env);
  for (const replacement of [{ serviceUrl: "https://changed.run.app" }, { audience: "changed" }, { modelDigest: "sha256:" + "c".repeat(64) }, { containerDigest: "sha256:" + "d".repeat(64) }]) {
    const fingerprint = config.ollamaDeploymentFingerprint({ ...configValues, ...replacement });
    assert.notEqual(policy.modelConfigurationFingerprint(model, { ...env, OLLAMA_DEPLOYMENT_FINGERPRINT: fingerprint }), original);
  }
  const record = { _id: model.id, verification: undefined } as unknown as import("../src/server/db/types").ModelRecordDocument;
  assert.match(policy.modelVerificationIssue(record, model)!, /live inference/);
});
