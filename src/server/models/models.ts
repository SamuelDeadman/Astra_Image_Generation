import "server-only";
import { generationSetupIssue } from "@/server/generations/readiness";
import { getModelById, type ModelDefinition } from "@/lib/models/catalog";
import { assertModelLiveVerified, modelVerificationIssue, supportedModelDefinition } from "@/server/models/policy";
import { isVerifyingModel } from "@/server/models/verification-context";
import { isVisibleImageModel } from "@/lib/models/huggingface-image";

import type { ProviderRoute } from "@/lib/workflow/schema";
import { notFound } from "@/server/errors";
import { mongoCollection } from "@/server/db/mongodb";
import { collectionNames, type ModelRecordDocument, type ProviderDocument } from "@/server/db/types";

export type ModelDTO = {
  id: string;
  name: string;
  route: ProviderRoute;
  provider: string;
  providerId: string;
  family: string;
  licence: string;
  licenceStatus: string;
  capabilities: unknown;
  maxPixels: number;
  maxSteps: number;
  baseCreditCost: number;
  pinnedVersion?: string;
  availability: "available" | "requires-credentials" | "development-only" | "not-configured" | "unavailable";
  isEnabled: boolean;
  generationUnavailableReason?: string;
  definition?: ModelDefinition;
};

export type EnabledModelRecord = Omit<ModelRecordDocument, "route"> & {
  id: string;
  route: ProviderRoute;
  provider: Omit<ProviderDocument, "route"> & { id: string; route: ProviderRoute };
};

export function normalizeModelRoute(route: string): ProviderRoute {
  if (route === "GCP_HOSTED") {
    return "gcp-hosted-gpu";
  }

  if (route === "EXTERNAL_BYOK") {
    return "external-byok";
  }

  if (
    route === "vertex-llm" ||
    route === "vertex-image" ||
    route === "google-ai-studio-image" ||
    route === "gcp-hosted-gpu" ||
    route === "huggingface-image" ||
    route === "external-byok" ||
    route === "development-fake"
  ) {
    return route;
  }

  throw notFound("The selected model route is not enabled or does not exist.");
}

function availabilityForModel(model: EnabledModelRecord): ModelDTO["availability"] {
  if (model.route === "development-fake") {
    return "development-only";
  }

  if (generationSetupIssue(model.route)) return "not-configured";
  if (
    model.route === "external-byok" ||
    model.route === "vertex-llm" ||
    model.route === "vertex-image" ||
    model.route === "google-ai-studio-image"
  ) {
    return "requires-credentials";
  }

  return "available";
}

function normalizeEnabledModel(model: ModelRecordDocument, provider: ProviderDocument): EnabledModelRecord {
  const definition = supportedModelDefinition(model, provider);
  const route = normalizeModelRoute(model.route);
  const providerRoute = normalizeModelRoute(provider.route);

  if (route === "development-fake" && process.env.NODE_ENV === "production") {
    throw notFound("The selected model is not enabled or does not exist.");
  }

  return {
    ...model,
    isEnabled: model.isEnabled || isVerifyingModel(model._id),
    displayName: definition.name,
    capabilities: definition.capabilities,
    licence: definition.licence,
    licenceStatus: definition.licenceStatus,
    maxPixels: definition.resolutions.length ? Math.max(...definition.resolutions.map((size) => size.width * size.height)) : 1536 * 1536,
    maxSteps: definition.numericBounds?.steps?.max ?? 0,
    baseCreditCost: definition.baseCreditCost,
    id: model._id,
    route,
    provider: {
      ...provider,
      name: definition.provider,
      id: provider._id,
      route: providerRoute
    }
  };
}

export function toModelDTO(model: EnabledModelRecord): ModelDTO {
  const definition = getModelById(model.id)!;
  const verificationIssue = modelVerificationIssue(model, definition);
  const unavailable = verificationIssue ?? (!model.isEnabled ? "This model is disabled. An operator must verify its live integration and enable the reviewed record." : null);
  return {
    id: model.id,
    name: model.displayName,
    route: model.route,
    provider: model.provider.name,
    providerId: model.provider.id,
    family: model.family,
    licence: model.licence,
    licenceStatus: model.licenceStatus,
    capabilities: model.capabilities,
    maxPixels: model.maxPixels,
    maxSteps: model.maxSteps,
    baseCreditCost: model.baseCreditCost,
    pinnedVersion: model.pinnedVersion,
    availability: unavailable ? "unavailable" : availabilityForModel(model),
    isEnabled: model.isEnabled,
    generationUnavailableReason: unavailable ?? generationSetupIssue(model.route) ?? undefined,
    definition
  };
}

export async function listModels(options?: { includeDisabled?: boolean; enabledOnly?: boolean }) {
  const models = await mongoCollection<ModelRecordDocument>(collectionNames.models);
  const providers = await mongoCollection<ProviderDocument>(collectionNames.providers);
  const records = await models
    .find(options?.enabledOnly ? { isEnabled: true } : {})
    .sort({ route: 1, displayName: 1 })
    .toArray();
  const providerIds = Array.from(new Set(records.map((model) => model.providerId)));
  const providerRecords = providerIds.length
    ? await providers.find({ _id: { $in: providerIds } }).toArray()
    : [];
  const providerById = new Map(providerRecords.map((provider) => [provider._id, provider]));

  return records
    .filter((model) => isVisibleImageModel(model._id))
    .map((model) => {
      const provider = providerById.get(model.providerId);

      if (!provider) {
        return null;
      }

      if (!options?.includeDisabled && !provider.isEnabled) {
        return null;
      }

      try {
        return toModelDTO(normalizeEnabledModel(model, provider));
      } catch {
        return null;
      }
    })
    .filter((model): model is ModelDTO => Boolean(model));
}

export async function listEnabledModels() {
  return (await listModels({ enabledOnly: true })).filter((model) => model.availability !== "unavailable");
}

export async function requireEnabledModel(modelId: string) {
  if (!isVisibleImageModel(modelId)) throw notFound("Only reviewed Ollama and Hugging Face image models are available.");
  const models = await mongoCollection<ModelRecordDocument>(collectionNames.models);
  const providers = await mongoCollection<ProviderDocument>(collectionNames.providers);
  const model = await models.findOne({
    _id: modelId
  });

  if (!model || (!model.isEnabled && !isVerifyingModel(modelId))) {
    throw notFound("The selected model is not enabled or does not exist.");
  }

  const provider = await providers.findOne({ _id: model.providerId });

  if (!provider || !provider.isEnabled) {
    throw notFound("The selected model provider is not enabled or does not exist.");
  }

  const result = normalizeEnabledModel(model, provider);
  if (!isVerifyingModel(modelId)) assertModelLiveVerified(model, getModelById(modelId)!);
  return result;
}

export async function requireEnabledModels(modelIds: string[]) {
  const uniqueModelIds = Array.from(new Set(modelIds));
  const records = await Promise.all(uniqueModelIds.map((modelId) => requireEnabledModel(modelId)));
  return records;
}
