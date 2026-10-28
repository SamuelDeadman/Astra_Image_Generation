import assert from "node:assert/strict";
import Module from "node:module";
import path from "node:path";
import test from "node:test";
import sharp from "sharp";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { modelCatalog, getModelById, isUserCredentialProvider, removedCatalogueIds } from "../src/lib/models/catalog";
import { previewModelDefaults, applyConfirmedModelDefaults, workflowModelConstraintIssues, effectiveImageValues } from "../src/lib/models/constraints";
import { baseTextToImageWorkflow } from "../src/lib/workflow/templates";
import { validateWorkflow } from "../src/lib/workflow/schema";
import { inspectImageBytes } from "../src/server/generations/image-bytes";

Object.assign(globalThis, { React });

const testRequire = Module.createRequire(path.join(process.cwd(), "tests", "model-catalogue.test.ts"));
function load<T>(file: string, mocks: Record<string, unknown> = {}): T {
  const loader = Module as unknown as { _load(request: string, parent: unknown, isMain: boolean): unknown };
  const original = loader._load;
  loader._load = function(request, parent, isMain) {
    if (request in mocks) return mocks[request];
    if (request === "server-only") return {};
    return original.call(this, request.startsWith("@/") ? path.join(process.cwd(), "src", request.slice(2)) : request, parent, isMain);
  };
  try { const resolved = testRequire.resolve(path.join(process.cwd(), file)); delete testRequire.cache[resolved]; return testRequire(resolved) as T; }
  finally { loader._load = original; }
}
function fixture() { return structuredClone(baseTextToImageWorkflow); }
const googleModel = getModelById("google-ai-studio-image")!;
const vertexModel = getModelById("vertex-gemini-image")!;
function workflowFor(id: string) {
  const workflow = fixture(); const definition = getModelById(id)!;
  workflow.selectedModel = id;
  workflow.executionEnvironment = definition.route === "google-ai-studio-image" ? "google-ai-studio" : definition.developmentOnly ? "development-local" : "gcp-hosted";
  return applyConfirmedModelDefaults(workflow, previewModelDefaults(workflow, definition), true);
}
function contextFor(id: string) {
  const definition = getModelById(id)!;
  const workflow = workflowFor(id);
  const node = workflow.nodes.find((node) => node.type === "text-to-image")!;
  return { job: { _id: "job", ownerId: "owner", workflowRevisionId: "revision" }, workflowRevision: { _id: "revision", workflow }, executionPlan: { planHash: "hash" }, step: { id: "step_image_model", nodeId: node.id, nodeType: "text-to-image", modelId: id, providerId: definition.providerId, pinnedModelVersion: definition.providerModelId, route: definition.route, adapterId: definition.route, parameters: node.data, estimates: { credits: 6 }, timeoutSeconds: 30 }, inputs: { prompt: { type: "text", text: "A blue ceramic cup on a neutral background." } }, attemptId: "attempt" } as unknown as import("../src/server/generations/inference-adapters").StepExecutionContext;
}

test("Google catalogue has only sourced, concrete current provider IDs", () => {
  for (const model of modelCatalog.filter((entry) => ["vertex-image", "google-ai-studio-image"].includes(entry.route))) {
    assert(model.sources.every((url) => url.startsWith("https://ai.google.dev/") || url.startsWith("https://docs.cloud.google.com/")));
    assert.equal(model.verifiedOn, "2026-10-13");
    assert(model.providerModelId.startsWith("gemini-"));
    assert.equal(model.capabilities.includes("lora"), false);
    assert.equal(model.capabilities.includes("controlnet"), false);
    assert.equal(model.capabilities.includes("upscale"), false);
    assert.equal(model.numericBounds?.steps, undefined);
    assert.equal(model.defaults.steps, undefined);
    assert(model.licenceUrl.startsWith("https://"));
  }
  assert.equal(vertexModel.credentialMode, "platform-identity");
  assert.equal(googleModel.credentialMode, "user-byok");
  for (const id of removedCatalogueIds) assert.equal(getModelById(id), undefined);
});

test("below-minimum, above-maximum and unsupported exact resolution are rejected without clamping", () => {
  for (const width of [1023, 4097, 1024.5, 1536]) {
    const workflow = workflowFor(googleModel.id);
    const node = workflow.nodes.find((node) => node.type === "text-to-image")!;
    if (node.type === "text-to-image") node.data.width = width;
    const dimensions = workflow.nodes.find((node) => node.type === "dimensions")!;
    if (dimensions.type === "dimensions") dimensions.data.width = width;
    const before = JSON.stringify(workflow);
    const issues = workflowModelConstraintIssues(workflow);
    assert(issues.some((entry) => entry.message.includes(String(width))));
    assert.equal(validateWorkflow(workflow).ok, false);
    assert.equal(JSON.stringify(workflow), before);
  }
});

test("development test constraints enforce actual increments and model bounds", () => {
  const workflow = workflowFor("development-fake-model");
  const dimensions = workflow.nodes.find((node) => node.type === "dimensions")!;
  if (dimensions.type === "dimensions") dimensions.data.width = 769;
  assert(workflowModelConstraintIssues(workflow).some((issue) => issue.field === "width" && issue.constraint.includes("increments of 8")));
});

test("connected dimensions are validated and used rather than ignored", () => {
  const workflow = workflowFor(vertexModel.id);
  const node = workflow.nodes.find((node) => node.type === "text-to-image")!;
  const dimensions = workflow.nodes.find((node) => node.type === "dimensions")!;
  if (dimensions.type === "dimensions") dimensions.data.width = 2048;
  assert.equal(effectiveImageValues(workflow, node).width, 2048);
  assert(workflowModelConstraintIssues(workflow).some((issue) => issue.nodeId === dimensions.id));
});

test("unsupported diffusion controls and batch are actionable validation failures", () => {
  const workflow = workflowFor(vertexModel.id);
  const node = workflow.nodes.find((node) => node.type === "text-to-image")!;
  if (node.type === "text-to-image") { node.data.steps = 30; node.data.cfg = 7; }
  const dimensions = workflow.nodes.find((node) => node.type === "dimensions")!;
  if (dimensions.type === "dimensions") dimensions.data.batch = 2;
  const issues = workflowModelConstraintIssues(workflow);
  assert(issues.some((issue) => issue.field === "steps"));
  assert(issues.some((issue) => issue.field === "cfg"));
  assert(issues.some((issue) => issue.field === "batch"));
  assert.equal(validateWorkflow(workflow).ok, false);
});

test("auto-fill previews every overwritten/deleted value and requires explicit confirmation", () => {
  const workflow = workflowFor("development-fake-model");
  const original = JSON.stringify(workflow);
  const preview = previewModelDefaults(workflow, googleModel);
  assert(preview.changes.some((change) => change.field === "steps" && change.after === undefined));
  assert(preview.changes.some((change) => change.field === "width" && change.before === 768 && change.after === 1024));
  assert.equal(JSON.stringify(workflow), original);
  assert.equal(applyConfirmedModelDefaults(workflow, preview, false), workflow);
  const changed = applyConfirmedModelDefaults(workflow, preview, true);
  assert.notEqual(changed, workflow);
  const node = changed.nodes.find((node) => node.type === "text-to-image")!;
  assert.equal("steps" in node.data, false);
  assert.equal(JSON.stringify(workflow), original);
});

test("stale auto-fill confirmation cannot overwrite a newly edited graph", () => {
  const workflow = fixture(); const preview = previewModelDefaults(workflow, googleModel);
  const changed = structuredClone(workflow); changed.nodes[0].label = "new input";
  assert.equal(applyConfirmedModelDefaults(changed, preview, true), changed);
});

test("per-node auto-fill retains unrelated nodes and warns about shared dimensions", () => {
  const workflow = workflowFor("development-fake-model");
  const node = workflow.nodes.find((node) => node.type === "text-to-image")!;
  const second = { ...structuredClone(node), id: "second_image" };
  workflow.nodes.push(second);
  const dimensions = workflow.nodes.find((node) => node.type === "dimensions")!;
  workflow.edges.push({ id: "shared-dimensions", source: dimensions.id, sourceHandle: "dimensions", target: second.id, targetHandle: "dimensions" });
  const preview = previewModelDefaults(workflow, googleModel, node.id);
  assert(preview.skipped.some((reason) => reason.includes("shared")));
  assert(preview.changes.every((change) => change.nodeId === node.id));
});

test("unknown/disabled server models are rejected even with browser-supplied limits", () => {
  const workflow = workflowFor(vertexModel.id);
  const result = validateWorkflow(workflow, { models: [{ id: "unknown-model", name: "Forged", route: "vertex-image", isEnabled: true, maxPixels: 999999999 }] });
  assert.equal(result.ok, false);
  assert.match(result.ok ? "" : result.issues.join(" "), /unavailable model/);
  assert.equal(validateWorkflow(workflow, { models: [] }).ok, false);
});

test("development model cannot pass production validation through a forged environment", () => {
  const workflow = workflowFor("development-fake-model"); workflow.executionEnvironment = "gcp-hosted";
  assert.equal(validateWorkflow(workflow, { nodeEnv: "production", models: [{ id: "development-fake-model", name: "Fake", route: "development-fake", maxPixels: 1536 * 1536 }] }).ok, false);
});

test("only implemented user BYOK providers are accepted; cloud keys and arbitrary providers are rejected", () => {
  assert.equal(isUserCredentialProvider("google-ai-studio", "google-ai-studio-image"), true);
  for (const [id, route] of [["astraflow-gcp", "GCP_HOSTED"], ["astraflow-vertex-image", "vertex-image"], ["google-ai-studio", "vertex-image"], ["external-byok", "EXTERNAL_BYOK"], ["https://attacker.invalid", "google-ai-studio-image"]]) assert.equal(isUserCredentialProvider(id, route), false);
});

test("credential read/decryption is bound to both owner and supported provider", async () => {
  let filter: unknown; let decrypted = false;
  const loadedModule = load<typeof import("../src/server/providers/credentials")>("src/server/providers/credentials.ts", {
    "@/server/db/mongodb": { mongoCollection: async (name: string) => name === "providers" ? { findOne: async (query: { _id: string }) => query._id === "google-ai-studio" ? { _id: "google-ai-studio", isEnabled: true, route: "google-ai-studio-image" } : { _id: query._id, isEnabled: true, route: "vertex-image" } } : { findOne: async (query: unknown) => { filter = query; return null; } } },
    "@/server/security/kms": { decryptUserSecret: async () => { decrypted = true; return "test-only-secret"; } }
  });
  await assert.rejects(loadedModule.loadUserProviderSecret("owner-1", "google-ai-studio"));
  assert.deepEqual(filter, { userId: "owner-1", provider: "google-ai-studio", mode: "SAVED_ENCRYPTED", deletedAt: { $exists: false } });
  assert.equal(decrypted, false);
  await assert.rejects(loadedModule.loadUserProviderSecret("owner-1", "astraflow-vertex-image"));
});

test("unverified or stale model records never report production availability", () => {
  const policy = load<typeof import("../src/server/models/policy")>("src/server/models/policy.ts");
  const record = { _id: vertexModel.id, providerId: vertexModel.providerId, route: vertexModel.route, pinnedVersion: vertexModel.providerModelId } as import("../src/server/db/types").ModelRecordDocument;
  const provider = { _id: vertexModel.providerId, route: vertexModel.route } as import("../src/server/db/types").ProviderDocument;
  assert.equal(policy.supportedModelDefinition(record, provider), vertexModel);
  assert.match(policy.modelVerificationIssue(record, vertexModel)!, /live inference/);
  assert.throws(() => policy.supportedModelDefinition({ ...record, pinnedVersion: "invented-version" }, provider));
  record.verification = { catalogueRevision: vertexModel.catalogueRevision, adapterRevision: vertexModel.adapterRevision, configurationFingerprint: policy.modelConfigurationFingerprint(vertexModel), verifiedAt: new Date(Date.now() - 1000), jobId: "job", assetId: "asset", sha256: "a".repeat(64), operations: vertexModel.capabilities };
  assert.equal(policy.modelVerificationIssue(record, vertexModel), null);
  record.verification.verifiedAt = new Date(Date.now() - 31 * 86400000);
  assert(policy.modelVerificationIssue(record, vertexModel));
});

test("valid image bytes are decoded; corrupt and header-only provider output fails", async () => {
  const bytes = await sharp({ create: { width: 1024, height: 1024, channels: 3, background: "blue" } }).png().toBuffer();
  assert.deepEqual(await inspectImageBytes(bytes), { width: 1024, height: 1024, contentType: "image/png" });
  await assert.rejects(inspectImageBytes(Buffer.from("not an image")));
  await assert.rejects(inspectImageBytes(bytes.subarray(0, 48)));
});

test("Google request contract uses the exact reviewed endpoint/model and owner key", async () => {
  let fetched: { url: string; body: Record<string, unknown>; headers: HeadersInit } | undefined;
  let owner: string | undefined;
  const previousFetch = globalThis.fetch;
  const loadedModule = load<typeof import("../src/server/generations/inference-adapters")>("src/server/generations/inference-adapters.ts", {
    "@/server/providers/credentials": { loadUserProviderSecret: async (id: string) => { owner = id; return "test-only-owner-key"; } }
  });
  globalThis.fetch = async (url, init) => { fetched = { url: String(url), body: JSON.parse(String(init?.body)), headers: init?.headers ?? {} }; return Response.json({}); };
  try {
    const adapter = loadedModule.getStepExecutionAdapterRegistration("google-ai-studio-image").adapter;
    await assert.rejects(adapter.execute(contextFor(googleModel.id), { progress: async () => undefined, isCancelled: async () => false }));
    assert.equal(owner, "owner");
    assert.equal(fetched?.url, "https://generativelanguage.googleapis.com/v1beta/interactions");
    assert.equal(fetched?.body.model, googleModel.providerModelId);
    assert.deepEqual(fetched?.body.response_format, { type: "image", mime_type: "image/png", aspect_ratio: "1:1", image_size: "1K" });
    assert.equal(JSON.stringify(fetched?.body).includes("test-only-owner-key"), false);
  } finally { globalThis.fetch = previousFetch; }
});

test("generic external/GPU adapters fail closed even if arbitrary URLs are configured", () => {
  const loadedModule = load<typeof import("../src/server/generations/inference-adapters")>("src/server/generations/inference-adapters.ts");
  assert.throws(() => loadedModule.assertStepExecutionAdapterConfigured("external-byok"), /No specifically implemented/);
  assert.throws(() => loadedModule.assertStepExecutionAdapterConfigured("gcp-hosted-gpu"), /no reviewed model runtime/);
});

test("warning rendering includes yellow-class value/constraint text and generation blocking", () => {
  const { WorkflowCanvas } = load<typeof import("../src/components/studio/WorkflowCanvas")>("src/components/studio/WorkflowCanvas.tsx");
  const workflow = workflowFor(vertexModel.id);
  const dimensions = workflow.nodes.find((node) => node.type === "dimensions")!;
  if (dimensions.type === "dimensions") dimensions.data.width = 1500;
  const html = renderToStaticMarkup(React.createElement(WorkflowCanvas, { workflow, workflowName: "Test", workflowId: null, models: [], generationBlockReason: "Unavailable pending live verification.", catalogueSelection: null, onWorkflowChange: () => undefined, onWorkflowNameChange: () => undefined, onWorkflowLoaded: () => undefined, onNotice: () => undefined }));
  assert.match(html, /model-constraint-warning/);
  assert.match(html, /1500/);
  assert.match(html, /supports these AstraFlow resolutions/);
  assert.match(html, /Generate unavailable/);
});

test("confirmation dialog renders affected values and cancel/confirm choices", () => {
  const { ModelDefaultsConfirmation } = load<typeof import("../src/components/studio/ModelDefaultsConfirmation")>("src/components/studio/ModelDefaultsConfirmation.tsx");
  const preview = previewModelDefaults(workflowFor("development-fake-model"), googleModel);
  const html = renderToStaticMarkup(React.createElement(ModelDefaultsConfirmation, { preview, modelName: googleModel.name, onCancel: () => undefined, onConfirm: () => undefined }));
  assert.match(html, /role="dialog"/); assert.match(html, /Confirm changes/); assert.match(html, /Cancel/); assert.match(html, /remove unsupported value/);
});

test("browser admission cannot select the private operator verification scope", async () => {
  let admitted = false;
  const route = load<typeof import("../src/app/api/generations/route")>("src/app/api/generations/route.ts", {
    "@/lib/auth/session": { requireCurrentSession: async () => ({ userId: "owner", role: "administrator" }) },
    "@/server/generations/generations": { createGenerationJob: async () => { admitted = true; } }
  });
  const response = await route.POST(new Request("https://studio.example/api/generations", { method: "POST", body: JSON.stringify({ workflow: fixture(), idempotencyKey: "test-only-admission-key", verificationModelId: vertexModel.id }) }));
  assert.equal(response.status, 400); assert.equal(admitted, false);
});

test("production execution blocks even a cached development adapter reference", async () => {
  const loaded = load<typeof import("../src/server/generations/inference-adapters")>("src/server/generations/inference-adapters.ts");
  const adapter = loaded.getStepExecutionAdapterRegistration("development-fake").adapter;
  const mutableEnv = process.env as Record<string, string | undefined>;
  const original = mutableEnv.NODE_ENV;
  mutableEnv.NODE_ENV = "production";
  try { await assert.rejects(adapter.execute(contextFor("development-fake-model"), { progress: async () => undefined, isCancelled: async () => false }), /Development fake inference is disabled/); }
  finally { if (original === undefined) delete mutableEnv.NODE_ENV; else mutableEnv.NODE_ENV = original; }
});

test("normal catalogue access excludes development in production and rejects invented enabled records", async () => {
  const mutableEnv = process.env as Record<string, string | undefined>; const original = mutableEnv.NODE_ENV; mutableEnv.NODE_ENV = "production";
  const now = new Date();
  const provider = { _id: "development-local", name: "Development", route: "development-fake", isEnabled: true, createdAt: now, updatedAt: now };
  const fake = { _id: "development-fake-model", providerId: provider._id, pinnedVersion: "development-fake-v1", route: "development-fake", isEnabled: true };
  const loaded = load<typeof import("../src/server/models/models")>("src/server/models/models.ts", {
    "@/server/db/mongodb": { mongoCollection: async (name: string) => name === "providers" ? { find: () => ({ toArray: async () => [provider] }), findOne: async () => provider } : { find: () => ({ sort: () => ({ toArray: async () => [fake] }) }), findOne: async (filter: { _id: string }) => filter._id === fake._id ? fake : { ...fake, _id: "invented-model" } } }
  });
  try {
    assert.deepEqual(await loaded.listModels(), []);
    await assert.rejects(loaded.requireEnabledModel("development-fake-model"));
    await assert.rejects(loaded.requireEnabledModel("invented-model"));
  } finally { if (original === undefined) delete mutableEnv.NODE_ENV; else mutableEnv.NODE_ENV = original; }
});

test("user and administrative catalogues expose reviewed Ollama/Hugging Face models and reject legacy inference", async () => {
  const model = getModelById("ollama-flux2-klein-4b-fp8")!;
  const visible = [model, getModelById("hf-z-image-turbo")!, getModelById("hf-flux2-klein-4b")!];
  const definitions = [...visible, googleModel, vertexModel, getModelById("development-fake-model")!];
  const providers = definitions.map((entry) => ({ _id: entry.providerId, route: entry.route, name: entry.provider, isEnabled: true }));
  const records = definitions.map((entry) => ({ _id: entry.id, providerId: entry.providerId, route: entry.route, displayName: entry.name, pinnedVersion: entry.providerModelId, isEnabled: true }));
  let lookups = 0;
  const models = load<typeof import("../src/server/models/models")>("src/server/models/models.ts", {
    "@/server/db/mongodb": { mongoCollection: async (name: string) => {
      lookups++;
      return name === "providers" ? { find: () => ({ toArray: async () => providers }) } : { find: () => ({ sort: () => ({ toArray: async () => records }) }) };
    } }
  });
  assert.deepEqual((await models.listModels()).map((entry) => entry.id), visible.map((entry) => entry.id));
  assert.deepEqual((await models.listModels({ includeDisabled: true })).map((entry) => entry.id), visible.map((entry) => entry.id));
  const before = lookups;
  for (const id of [googleModel.id, vertexModel.id, "development-fake-model", "ollama-z-image-turbo-fp8"]) await assert.rejects(models.requireEnabledModel(id), /Only reviewed Ollama and Hugging Face/);
  assert.equal(lookups, before);
});

test("execution selector offers the two L4 runtimes and hides legacy choices", () => {
  const { ExecutionEnvironmentSelector } = load<typeof import("../src/components/studio/ExecutionEnvironmentSelector")>("src/components/studio/ExecutionEnvironmentSelector.tsx");
  const html = renderToStaticMarkup(React.createElement(ExecutionEnvironmentSelector, { value: "gcp-hosted", models: [], allowDevelopmentLocal: true, onChange: () => undefined }));
  assert.match(html, /GCP hosted worker/);
  assert.match(html, /L4/);
  assert.match(html, /FLUX.2 Klein 4B FP8/);
  assert.match(html, /Hugging Face on GCP L4/);
  assert.match(html, /Z-Image Turbo/);
  assert.doesNotMatch(html, /Google AI Studio|External BYOK|Local development|Vertex/);
});

test("other provider solutions return no choices and reject new credentials", async () => {
  const mocks = { "@/lib/auth/session": { requireCurrentSession: async () => ({ userId: "owner" }) } };
  const listing = load<typeof import("../src/app/api/providers/route")>("src/app/api/providers/route.ts", mocks);
  assert.deepEqual(await (await listing.GET()).json(), { providers: [], credentials: [] });
  const credentials = load<typeof import("../src/app/api/providers/[provider]/credentials/route")>("src/app/api/providers/[provider]/credentials/route.ts", mocks);
  assert.equal((await credentials.POST()).status, 410);
});
