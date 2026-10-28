import nextEnv from "@next/env";
import { readFileSync } from "node:fs";
import { MongoClient, ServerApiVersion } from "mongodb";

nextEnv.loadEnvConfig(process.cwd(), process.env.NODE_ENV !== "production");

const expectedDbName = "astraflow_dev";
const requiredCollections = [
  "users",
  "sessions",
  "api_credentials",
  "providers",
  "models",
  "workflows",
  "workflow_revisions",
  "workflow_share_links",
  "workflow_events",
  "execution_plans",
  "generation_jobs",
  "assets",
  "credit_transactions",
  "audit_events"
];

const definitions = JSON.parse(readFileSync(new URL("../src/lib/models/definitions.json", import.meta.url), "utf8"))
  .filter((model) => ["ollama-flux2-klein-4b-fp8", "hf-z-image-turbo", "hf-flux2-klein-4b"].includes(model.id));
const providers = definitions.map((model) => ({ _id: model.providerId, name: model.provider, route: model.route, isEnabled: !model.developmentOnly || process.env.NODE_ENV !== "production", credentialSchema: { mode: model.credentialMode } }));
const models = definitions.filter((model) => !model.developmentOnly || process.env.NODE_ENV !== "production").map((model) => ({
  _id: model.id, providerId: model.providerId, displayName: model.name, family: model.family, route: model.route,
  licence: model.licence, licenceStatus: model.licenceStatus, capabilities: model.capabilities,
  maxPixels: model.resolutions.length ? Math.max(...model.resolutions.map((size) => size.width * size.height)) : 1536 * 1536,
  maxSteps: model.numericBounds?.steps?.max ?? 0, baseCreditCost: model.baseCreditCost,
  pinnedVersion: model.providerModelId, isEnabled: Boolean(model.developmentOnly),
  catalogueRevision: model.catalogueRevision
}));
const obsoleteModels = ["ollama-z-image-turbo-fp8", "google-ai-studio-image", "vertex-gemini-image", "development-fake-model","gcp-openweight-xl", "gcp-fast-preview", "gcp-control-lab", "byok-provider-route", "vertex-imagen-studio", "vertex-gemini-llm"];

function requiredEnv(name) {
  const value = process.env[name];

  if (!value || !value.trim()) {
    throw new Error(`${name} is not configured.`);
  }

  return value;
}

async function main() {
  const uri = requiredEnv("MONGODB_URI");
  const dbName = requiredEnv("MONGODB_DB_NAME");

  const controlledSync = process.argv.includes("--controlled-sync");
  const explicitDatabase = process.argv[process.argv.indexOf("--database") + 1];
  if (controlledSync && (!process.argv.includes("--database") || explicitDatabase !== dbName)) throw new Error("Controlled catalogue sync requires --database matching MONGODB_DB_NAME. Review the configured deployment target first.");
  if (!controlledSync && dbName !== expectedDbName) {
    throw new Error(`Refusing to seed ${dbName}. Set MONGODB_DB_NAME=${expectedDbName}.`);
  }

  const client = new MongoClient(uri, {
    appName: process.env.MONGODB_APP_NAME ?? "astraflow-image-studio-seed",
    serverSelectionTimeoutMS: Number(process.env.MONGODB_SERVER_SELECTION_TIMEOUT_MS ?? 5000),
    serverApi:
      process.env.MONGODB_SERVER_API_VERSION === "1"
        ? { version: ServerApiVersion.v1, strict: false, deprecationErrors: true }
        : undefined
  });

  try {
    await client.connect();
    const db = client.db(dbName);
    const existing = await db.listCollections({}, { nameOnly: true }).toArray();
    const existingNames = new Set(existing.map((collection) => collection.name));
    const missing = requiredCollections.filter((collection) => !existingNames.has(collection));

    if (missing.length > 0) {
      throw new Error(
        `Required collections are missing: ${missing.join(", ")}. Run /ready with MONGODB_AUTO_ENSURE_INDEXES=true before seeding.`
      );
    }

    const now = new Date();
    await db.collection("models").updateMany({ _id: { $in: obsoleteModels } }, { $set: { isEnabled: false, updatedAt: now }, $unset: { verification: "" } });
    await db.collection("providers").updateMany({ _id: { $in: ["astraflow-gcp", "external-byok", "google-ai-studio", "astraflow-vertex-image", "development-local"] } }, { $set: { isEnabled: false, updatedAt: now } });
    if (process.env.NODE_ENV === "production") await db.collection("models").updateMany({ route: "development-fake" }, { $set: { isEnabled: false, updatedAt: now } });

    for (const provider of providers) {
      await db.collection("providers").updateOne(
        { _id: provider._id },
        {
          $set: { ...provider, updatedAt: now },
          $setOnInsert: { createdAt: now }
        },
        { upsert: true }
      );
    }

    for (const model of models) {
      await db.collection("models").updateOne({ _id: model._id, $or: [{ pinnedVersion: { $ne: model.pinnedVersion } }, { catalogueRevision: { $ne: model.catalogueRevision } }] }, { $set: { isEnabled: false }, $unset: { verification: "" } });
      const { isEnabled, ...metadata } = model;
      await db.collection("models").updateOne(
        { _id: model._id },
        {
          $set: { ...metadata, updatedAt: now },
          $setOnInsert: { createdAt: now, isEnabled }
        },
        { upsert: true }
      );
    }

    console.log(`Seeded ${providers.length} reviewed providers and ${models.length} models. Production entries are disabled until live verification; obsolete entries were disabled.`);
  } finally {
    await client.close();
  }
}

main().catch((error) => {
  // Driver messages can contain connection details; keep diagnostics bounded.
  console.error(error?.name?.startsWith("Mongo") ? "MongoDB seed failed. Check connectivity, database permissions and /ready schema setup." : error instanceof Error ? error.message : "Seed failed.");
  process.exitCode = 1;
});
