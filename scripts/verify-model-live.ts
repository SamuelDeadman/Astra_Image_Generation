import assert from "node:assert/strict";
import crypto from "node:crypto";
import Module from "node:module";
import path from "node:path";
import { loadEnvConfig } from "@next/env";

// Operator-only integration runner. Uses real MongoDB, Cloud Tasks, worker,
// provider inference, KMS and GCS. No mocked result and no browser session bypass.
loadEnvConfig(process.cwd(), process.env.NODE_ENV !== "production");
const loader = Module as unknown as { _load(request: string, parent: unknown, isMain: boolean): unknown };
const originalLoad = loader._load;
loader._load = function(request, parent, isMain) {
  if (request === "server-only") return {};
  return originalLoad.call(this, request.startsWith("@/") ? path.join(process.cwd(), "src", request.slice(2)) : request, parent, isMain);
};

async function main() {
  const { getModelById } = await import("../src/lib/models/catalog");
  const model = getModelById(process.argv[2] ?? "");
  assert(model && !model.developmentOnly, "Supply a reviewed production catalogue ID.");
  const { isVisibleImageModel } = await import("../src/lib/models/huggingface-image");
  assert(isVisibleImageModel(model.id), "Only reviewed Ollama and Hugging Face models can be enabled.");
  if (model.route === "huggingface-image") {
    const { assertHuggingFaceConfigured } = await import("../src/server/generations/huggingface-image-config");
    assertHuggingFaceConfigured();
  }
  const required = ["MONGODB_URI", "MONGODB_DB_NAME", "MODEL_VERIFY_OWNER_ID", "GCP_PROJECT_ID", "GCS_INPUT_BUCKET", "GCS_OUTPUT_BUCKET", "GCP_TASKS_LOCATION", "GCP_TASKS_QUEUE", "GENERATION_WORKER_URL", "WORKER_INVOKER_SERVICE_ACCOUNT_EMAIL", "WORKER_AUDIENCE", "KMS_KEY_RESOURCE", ...(model.route === "vertex-image" ? ["VERTEX_AI_LOCATION"] : [])];
  const missing = required.filter((name) => !process.env[name]?.trim());
  if (missing.length) throw new Error(`LIVE VERIFICATION NOT RUN. Missing configuration: ${missing.join(", ")}.`);
  assert(process.env.GENERATION_LOCAL_WORKER_ENABLED !== "true", "Live verification requires Cloud Tasks dispatch, not the local development worker.");
  if (model.route === "gcp-hosted-gpu") {
    const { assertOllamaImageConfigured } = await import("../src/server/generations/ollama-image-config");
    assertOllamaImageConfigured();
  }
  const { mongoCollection, getMongoClient } = await import("../src/server/db/mongodb");
  const { collectionNames } = await import("../src/server/db/types");
  const { mapRole } = await import("../src/server/auth/roles");
  const { supportedModelDefinition, modelConfigurationFingerprint } = await import("../src/server/models/policy");
  const { withModelVerification } = await import("../src/server/models/verification-context");
  const { createGenerationJob } = await import("../src/server/generations/generations");
  const { inspectImageBytes } = await import("../src/server/generations/image-bytes");
  const { readPrivateObject } = await import("../src/server/gcp/storage");
  const users = await mongoCollection<import("../src/server/db/types").UserDocument>(collectionNames.users);
  const owner = await users.findOne({ _id: process.env.MODEL_VERIFY_OWNER_ID, isSuspended: false, deletedAt: { $exists: false } });
  assert(owner && owner.role === "ADMINISTRATOR", "MODEL_VERIFY_OWNER_ID must identify an existing, active application administrator.");
  const records = await mongoCollection<import("../src/server/db/types").ModelRecordDocument>(collectionNames.models);
  const providers = await mongoCollection<import("../src/server/db/types").ProviderDocument>(collectionNames.providers);
  const record = await records.findOne({ _id: model.id });
  const provider = await providers.findOne({ _id: model.providerId, isEnabled: true });
  assert(record && provider, "Seed the reviewed catalogue/provider first.");
  supportedModelDefinition(record, provider);
  const jobs = await mongoCollection<import("../src/server/db/types").GenerationJobDocument>(collectionNames.generationJobs);
  const assets = await mongoCollection<import("../src/server/db/types").AssetDocument>(collectionNames.assets);
  let lastAsset: import("../src/server/db/types").AssetDocument | null = null;
  let lastJobId = "";
  try {
    // Verify every advertised image operation and resolution; one real stored result per case.
    for (const operation of model.capabilities) {
      for (const size of model.resolutions) {
       for (const outputFormat of model.outputFormats) {
        const imageNode = { id: "image_model", type: operation, position: { x: 320, y: 0 }, data: { modelId: model.id, route: model.route, prompt: operation === "text-to-image" ? "Generate a simple blue ceramic cup on a neutral studio background. No text." : "Change the ceramic cup to green and keep a neutral studio background.", negativePrompt: "", width: size.width, height: size.height, batch: 1, outputFormat, storagePolicy: { visibility: "private", retainIntermediate: true } } };
        const nodes: unknown[] = [imageNode, { id: "output", type: "output", position: { x: 640, y: 0 }, data: { format: "png", privateByDefault: true, includeMetadata: true } }];
        const edges = [{ id: "image-output", source: "image_model", sourceHandle: "image", target: "output", targetHandle: "image" }];
        if (operation === "image-to-image") {
          assert(lastAsset, "Text-to-image verification must produce an owned source asset first.");
          nodes.push({ id: "source", type: "starting-image", position: { x: 0, y: 0 }, data: { assetId: lastAsset._id, strength: 0.45 } });
          edges.push({ id: "source-image", source: "source", sourceHandle: "image", target: "image_model", targetHandle: "image" });
        }
        const workflow = { schemaVersion: 3, selectedModel: model.id, executionEnvironment: model.route === "huggingface-image" ? "huggingface-l4" : ["vertex-image", "gcp-hosted-gpu"].includes(model.route) ? "gcp-hosted" : "google-ai-studio", nodes, edges };
        const result: { job: import("../src/server/generations/generations").GenerationJobDTO; idempotentReplay: boolean } = await withModelVerification(model.id, async (): Promise<{ job: import("../src/server/generations/generations").GenerationJobDTO; idempotentReplay: boolean }> => createGenerationJob({ ownerId: owner._id, role: mapRole(owner.role), workflow, workflowName: `Live model verification: ${model.name}`, idempotencyKey: `model-verification-${crypto.randomUUID()}` }));
        lastJobId = result.job.id;
        console.log(`${model.id}: ${operation} ${size.width}x${size.height} job accepted; awaiting real worker output.`);
        const deadline = Date.now() + 20 * 60 * 1000;
        let job = await jobs.findOne({ _id: result.job.id, ownerId: owner._id });
        while (job && !["COMPLETED", "FAILED", "CANCELLED", "EXPIRED", "MODERATION_BLOCKED"].includes(job.status) && Date.now() < deadline) {
          await new Promise((resolve) => setTimeout(resolve, 5000));
          job = await jobs.findOne({ _id: result.job.id, ownerId: owner._id });
        }
        assert(job?.status === "COMPLETED", `Live job did not complete: ${job?.status ?? "missing"}; safe code ${job?.errorCode ?? "none"}.`);
        lastAsset = await assets.findOne({ ownerId: owner._id, generationJobId: result.job.id, visibility: "PRIVATE", isPrivate: true, kind: "GENERATED_OUTPUT", "metadata.developmentOnly": { $ne: true } });
        assert(lastAsset && lastAsset.bucket === process.env.GCS_OUTPUT_BUCKET, "Real private output asset is missing or in the wrong bucket.");
        const bytes = await readPrivateObject({ bucket: lastAsset.bucket, objectPath: lastAsset.objectPath });
        const info = await inspectImageBytes(bytes);
        assert.equal(info.width, size.width); assert.equal(info.height, size.height);
        assert.equal(info.contentType, `image/${outputFormat}`);
        assert.equal(crypto.createHash("sha256").update(bytes).digest("hex"), lastAsset.sha256);
        assert.equal(bytes.byteLength, lastAsset.sizeBytes);
        console.log(`${model.id}: ${operation} ${size.width}x${size.height} real image decoded and private stored bytes verified.`);
       }
      }
    }
    assert(lastAsset?.sha256);
    await records.updateOne({ _id: model.id, pinnedVersion: model.providerModelId }, { $set: { isEnabled: true, verification: { catalogueRevision: model.catalogueRevision, adapterRevision: model.adapterRevision, configurationFingerprint: modelConfigurationFingerprint(model), verifiedAt: new Date(), jobId: lastJobId, assetId: lastAsset._id, sha256: lastAsset.sha256, operations: model.capabilities }, updatedAt: new Date() } });
    console.log(`${model.id}: LIVE VERIFIED AND ENABLED. Evidence is valid for this configuration/revision for 30 days.`);
  } catch (error) {
    await records.updateOne({ _id: model.id }, { $set: { isEnabled: false }, $unset: { verification: "" } });
    throw error;
  } finally { await (await getMongoClient()).close(); }
}
main().catch((error: unknown) => {
  // Never print driver errors, provider bodies, token-bearing stacks or connection strings.
  console.error(error instanceof Error && (error.name === "AssertionError" || error.message.startsWith("LIVE VERIFICATION NOT RUN")) ? error.message : "LIVE VERIFICATION FAILED. Model remains unavailable; inspect safe application job error codes and cloud setup.");
  process.exitCode = 1;
});
