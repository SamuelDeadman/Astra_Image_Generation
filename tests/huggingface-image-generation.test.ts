import assert from "node:assert/strict";
import crypto from "node:crypto";
import { readFileSync } from "node:fs";
import Module from "node:module";
import path from "node:path";
import test, { before, after } from "node:test";
import sharp from "sharp";
import { huggingFaceImageModels, huggingFaceCatalogueSha256 } from "../src/lib/models/huggingface-image";
import { getModelById } from "../src/lib/models/catalog";
import { workflowTemplates } from "../src/lib/workflow/templates";
import { validateWorkflow } from "../src/lib/workflow/schema";
import { stringifyWorkflowDocument } from "../src/lib/workflow/serialization";
import type { EnabledModelRecord } from "../src/server/models/models";
import type { StepExecutionContext } from "../src/server/generations/inference-adapters";

const loader = Module as unknown as { _load(request: string, parent: unknown, isMain: boolean): unknown };
const originalLoad = loader._load;
const load = Module.createRequire(path.join(process.cwd(), "tests/huggingface-image-generation.test.ts"));
const writes: Array<{ data: Buffer; bucket: string; objectPath: string; contentType: string }> = [];
const audiences: string[] = [];
loader._load = function(request, parent, isMain) {
  if (request === "server-only") return {};
  if (request === "google-auth-library") return { GoogleAuth: class {
    async getIdTokenClient(audience: string) { audiences.push(audience); return { getRequestHeaders: async () => new Headers({ authorization: "Bearer test-service-id-token" }) }; }
    async getAccessToken() { throw new Error("Use ID tokens only"); }
  } };
  if (request === "@/server/gcp/storage") return { writePrivateObject: async (input: (typeof writes)[number]) => {
    writes.push(input); return { sizeBytes: input.data.length, sha256: crypto.createHash("sha256").update(input.data).digest("hex") };
  } };
  return originalLoad.call(this, request.startsWith("@/") ? path.join(process.cwd(), "src", request.slice(2)) : request, parent, isMain);
};
const config = load("../src/server/generations/huggingface-image-config") as typeof import("../src/server/generations/huggingface-image-config");
const client = load("../src/server/generations/huggingface-image-client") as typeof import("../src/server/generations/huggingface-image-client");
const adapters = load("../src/server/generations/inference-adapters") as typeof import("../src/server/generations/inference-adapters");
const compiler = load("../src/server/workflows/compiler") as typeof import("../src/server/workflows/compiler");
const policy = load("../src/server/models/policy") as typeof import("../src/server/models/policy");
const pins = { serviceUrl: "https://private-hf-123.run.app", audience: "https://run.googleapis.com/projects/test/services/hf/diffusers", containerDigest: "sha256:" + "a".repeat(64), catalogueSha256: huggingFaceCatalogueSha256 };
const env = { NODE_ENV: "test" as const, HF_IMAGE_GENERATION_ENABLED: "true", HF_MODEL_CACHE_READY: "true", HF_MODEL_CATALOGUE_SHA256: pins.catalogueSha256, HF_CONTAINER_DIGEST: pins.containerDigest, HF_SERVICE_URL: pins.serviceUrl, HF_AUDIENCE: pins.audience, HF_DEPLOYMENT_FINGERPRINT: config.huggingFaceDeploymentFingerprint(pins), ASTRAFLOW_RUNTIME_ROLE: "worker", WORKER_AUDIENCE: "https://tasks.example", GCS_OUTPUT_BUCKET: "private-output" };
const previousEnv = Object.fromEntries(Object.keys(env).map((key) => [key, process.env[key]]));
const previousFetch = globalThis.fetch;
Object.assign(process.env, env);
let png: Buffer;
before(async () => { png = await sharp({ create: { width: 1024, height: 1024, channels: 3, background: "green" } }).png().toBuffer(); });
after(() => {
  loader._load = originalLoad; globalThis.fetch = previousFetch;
  for (const [key, value] of Object.entries(previousEnv)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
});
const hooks = { isCancelled: async () => false, progress: async () => undefined };
const input = { modelId: huggingFaceImageModels[0].id, prompt: 'A studio photograph of a cup with "TEA" printed on it.', timeoutSeconds: 10 };
function imageResponse(modelId = input.modelId, bytes = png, override: Record<string, string> = {}) {
  const model = huggingFaceImageModels.find((entry) => entry.id === modelId)!;
  return new Response(new Uint8Array(bytes), { headers: { "content-type": "image/png", "x-model-id": model.id, "x-model-revision": model.revision, "x-model-catalogue-sha256": pins.catalogueSha256, ...override } });
}
function hasCode(code: string, retryable = false) {
  return (error: unknown) => { assert(error instanceof config.HuggingFaceImageError); assert.equal(error.code, code); assert.equal(error.retryable, retryable); return true; };
}
function context(modelId: string): StepExecutionContext {
  const definition = getModelById(modelId)!;
  const workflow = structuredClone(workflowTemplates.find((entry) => entry.modelId === modelId)!.workflow);
  const node = workflow.nodes.find((entry) => entry.type === "text-to-image")!;
  return { job: { _id: "job_hf", ownerId: "owner_hf", workflowRevisionId: "revision_hf" }, workflowRevision: { _id: "revision_hf", workflow }, executionPlan: { planHash: "hash" }, attemptId: "attempt_hf", inputs: { prompt: { type: "text", text: input.prompt }, dimensions: { type: "dimensions", width: 1024, height: 1024, batch: 1 } }, step: { id: "step_image", nodeId: node.id, nodeType: "text-to-image", modelId, providerId: definition.providerId, pinnedModelVersion: definition.providerModelId, route: definition.route, adapterId: definition.route, parameters: { ...node.data }, estimates: { credits: 6 }, timeoutSeconds: 10 } } as unknown as StepExecutionContext;
}

function enabledModel(modelId: string): EnabledModelRecord & { name: string } {
  const model = getModelById(modelId)!;
  const now = new Date();
  return { _id: model.id, id: model.id, name: model.name, displayName: model.name, family: model.family, providerId: model.providerId, route: model.route, licence: model.licence, licenceStatus: model.licenceStatus, capabilities: model.capabilities, maxPixels: 1024 ** 2, maxSteps: 0, baseCreditCost: 6, isEnabled: true, pinnedVersion: model.providerModelId, createdAt: now, updatedAt: now, provider: { _id: model.providerId, id: model.providerId, name: model.provider, route: model.route, isEnabled: true, createdAt: now, updatedAt: now } };
}

test("model options pin official commits and share the canonical cache catalogue", () => {
  const catalogue = JSON.parse(readFileSync("src/lib/models/huggingface-models.json", "utf8"));
  const canonical = (value: unknown): string => Array.isArray(value) ? `[${value.map(canonical).join(",")}]` : value !== null && typeof value === "object" ? `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical((value as Record<string, unknown>)[key])}`).join(",")}}` : JSON.stringify(value);
  assert.equal(crypto.createHash("sha256").update(canonical(catalogue)).digest("hex"), pins.catalogueSha256);
  for (const model of huggingFaceImageModels) {
    assert.match(model.revision, /^[a-f0-9]{40}$/);
    assert.equal(getModelById(model.id)!.providerModelId, `${model.repository}@${model.revision}`);
    assert.deepEqual(getModelById(model.id)!.capabilities, ["text-to-image"]);
  }
});

test("each Hugging Face template validates, serializes and compiles to its pinned adapter", () => {
  for (const model of huggingFaceImageModels) {
    const ctx = context(model.id);
    const models = [enabledModel(model.id)];
    assert.equal(validateWorkflow(ctx.workflowRevision.workflow, { models }).ok, true);
    assert.equal(validateWorkflow(JSON.parse(stringifyWorkflowDocument(ctx.workflowRevision.workflow)), { models }).ok, true);
    const plan = compiler.compileWorkflowExecutionPlan({ workflow: ctx.workflowRevision.workflow, models, ownerId: "owner_hf", workflowId: "workflow_hf", workflowRevisionId: "revision_hf" });
    const step = plan.steps.find((entry) => entry.nodeType === "text-to-image")!;
    assert.equal(step.adapterId, "huggingface-image"); assert.equal(step.modelId, model.id);
    assert.equal(validateWorkflow({ ...ctx.workflowRevision.workflow, executionEnvironment: "gcp-hosted" }, { models }).ok, false);
    const invalid = structuredClone(ctx.workflowRevision.workflow);
    const node = invalid.nodes.find((entry) => entry.type === "text-to-image")!;
    if (node.type === "text-to-image") node.data.modelId = "invented-model";
    assert.equal(validateWorkflow(invalid, { models }).ok, false);
  }
});

test("both model selections produce a private ID-token request with exact revisions", async () => {
  for (const model of huggingFaceImageModels) {
    const bytes = await client.generateHuggingFaceImage({ ...input, modelId: model.id }, hooks, { fetch: async (url, init) => {
      assert.equal(String(url), pins.serviceUrl + "/v1/images/generations");
      assert.equal(init?.method, "POST"); assert.equal(init?.redirect, "error");
      assert.equal(new Headers(init?.headers).get("authorization"), "Bearer test-service-id-token");
      assert.deepEqual(JSON.parse(String(init?.body)), { model: model.id, revision: model.revision, catalogue_sha256: pins.catalogueSha256, prompt: input.prompt, width: 1024, height: 1024, timeout_seconds: 10 });
      return imageResponse(model.id);
    } });
    assert.deepEqual(bytes, png); assert.equal(audiences.at(-1), pins.audience);
  }
});

test("configuration rejects public/custom endpoints, stale pins and reused task audiences", () => {
  for (const change of [{ HF_IMAGE_GENERATION_ENABLED: "false" }, { HF_MODEL_CACHE_READY: "false" }, { HF_MODEL_CATALOGUE_SHA256: "a".repeat(64) }, { HF_CONTAINER_DIGEST: "latest" }, { HF_DEPLOYMENT_FINGERPRINT: "a".repeat(64) }, { HF_SERVICE_URL: "https://external.example" }, { HF_SERVICE_URL: pins.serviceUrl + "/inference" }, { HF_SERVICE_URL: pins.serviceUrl + "?token=secret" }, { HF_AUDIENCE: env.WORKER_AUDIENCE }]) assert.throws(() => config.getHuggingFaceConfiguration({ ...env, ...change }));
  assert.doesNotThrow(() => config.assertHuggingFaceConfigured({ ...env, ASTRAFLOW_RUNTIME_ROLE: "web", HF_SERVICE_URL: undefined, HF_AUDIENCE: undefined }));
});

test("wrong-model replies, malformed images and oversized responses fail before storage", async () => {
  const wrongSize = await sharp(png).resize(512, 512).png().toBuffer();
  const responses = [imageResponse(input.modelId, png, { "x-model-revision": "b".repeat(40) }), imageResponse(input.modelId, png, { "x-model-id": "other" }), imageResponse(input.modelId, png, { "x-model-catalogue-sha256": "b".repeat(64) }), imageResponse(input.modelId, Buffer.from("text")), imageResponse(input.modelId, wrongSize), imageResponse(input.modelId, png.subarray(0, 50)), imageResponse(input.modelId, png, { "content-length": String(client.maxHuggingFaceImageBytes + 1) }), Response.json({ image: "text" })];
  for (const response of responses) await assert.rejects(client.generateHuggingFaceImage(input, hooks, { fetch: async () => response }), hasCode("HF_OUTPUT_INVALID"));
  await assert.rejects(client.generateHuggingFaceImage(input, hooks, { fetch: async () => imageResponse(input.modelId, Buffer.alloc(client.maxHuggingFaceImageBytes + 1)) }), hasCode("HF_OUTPUT_TOO_LARGE"));
});

test("IAM and capacity failures use safe messages and correct retry policy", async () => {
  for (const status of [401, 403, 400, 422, 429, 500, 503]) {
    await assert.rejects(client.generateHuggingFaceImage(input, hooks, { fetch: async () => new Response("secret-provider-body", { status }) }), hasCode(status === 401 || status === 403 ? "HF_ACCESS_DENIED" : "HF_REQUEST_FAILED", status === 429 || status >= 500));
  }
});

test("pre-request cancellation prevents inference and deadlines abort stalled auth/transport", async () => {
  let called = false;
  await assert.rejects(client.generateHuggingFaceImage(input, { isCancelled: async () => true }, { fetch: async () => { called = true; return imageResponse(); } }), hasCode("GENERATION_CANCELLED"));
  assert.equal(called, false);
  await assert.rejects(client.generateHuggingFaceImage({ ...input, timeoutSeconds: 1 }, hooks, { idTokenHeaders: async () => new Promise(() => {}) }), hasCode("HF_REQUEST_TIMEOUT", true));
  let checks = 0;
  let aborted = false;
  await assert.rejects(client.generateHuggingFaceImage(input, { isCancelled: async () => ++checks > 1 }, { fetch: async (_url, init) => new Promise((_resolve, reject) => {
    init!.signal!.addEventListener("abort", () => { aborted = true; reject(new Error("transport aborted")); }, { once: true });
  }) }), hasCode("GENERATION_CANCELLED"));
  assert.equal(aborted, true);
});

test("validated workflow adapters save verified PNG bytes using the existing private storage lifecycle", async () => {
  for (const model of huggingFaceImageModels) {
    const ctx = context(model.id);
    const beforeWrites = writes.length;
    ctx.executionPlan = compiler.compileWorkflowExecutionPlan({ workflow: ctx.workflowRevision.workflow, models: [enabledModel(model.id)], ownerId: "owner_hf", workflowId: "workflow_hf", workflowRevisionId: "revision_hf" });
    ctx.step = ctx.executionPlan.steps.find((step) => step.nodeType === "text-to-image")!;
    globalThis.fetch = async () => imageResponse(model.id);
    const result = await adapters.getStepExecutionAdapter("huggingface-image").execute(ctx, hooks);
    assert.equal(writes.length, beforeWrites + 1);
    assert.equal(writes.at(-1)?.bucket, env.GCS_OUTPUT_BUCKET);
    assert.deepEqual(writes.at(-1)?.data, png);
    assert.equal(result.outputs.image.type, "image");
    assert.equal(result.usage?.revision, model.revision);
    const invalid = context(model.id); invalid.step.pinnedModelVersion = "attacker/model@main";
    await assert.rejects(adapters.getStepExecutionAdapter("huggingface-image").execute(invalid, hooks));
    assert.equal(writes.length, beforeWrites + 1);
  }
});

test("unsupported controls and source-image inputs never reach inference", async () => {
  let requests = 0; globalThis.fetch = async () => { requests++; return imageResponse(); };
  for (const value of ["negativePrompt", "seed", "steps", "cfg"]) {
    const ctx = context(input.modelId); ctx.step.parameters[value] = value === "negativePrompt" ? "negative" : 1;
    await assert.rejects(adapters.getStepExecutionAdapter("huggingface-image").execute(ctx, hooks));
  }
  const ctx = context(input.modelId); ctx.inputs.image = { type: "image", assetId: "source" } as never;
  await assert.rejects(adapters.getStepExecutionAdapter("huggingface-image").execute(ctx, hooks));
  assert.equal(requests, 0);
});

test("live verification fingerprints bind Hugging Face deployments independently of Ollama", () => {
  const model = getModelById(input.modelId)!;
  const baseline = policy.modelConfigurationFingerprint(model, env);
  assert.notEqual(baseline, policy.modelConfigurationFingerprint(model, { ...env, HF_DEPLOYMENT_FINGERPRINT: "changed" }));
  assert.equal(baseline, policy.modelConfigurationFingerprint(model, { ...env, OLLAMA_DEPLOYMENT_FINGERPRINT: "changed" }));
});
