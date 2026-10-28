import definitions from "./definitions.json";
import type { ProviderRoute } from "../workflow/schema";

export type NumericBound = { min: number; max: number; step: number };
export type ModelDefinition = {
  id: string; name: string; providerId: string; provider: string; providerModelId: string;
  route: ProviderRoute; family: string; credentialMode: "user-byok" | "platform-identity" | "none";
  capabilities: string[]; modalities: { input: string[]; output: string[] };
  defaults: Record<string, string | number | boolean>;
  numericBounds?: Record<string, NumericBound>;
  resolutions: { width: number; height: number; aspectRatio: string; imageSize: string }[];
  unsupportedParameters: string[]; negativePromptSupported: boolean; outputFormats: string[];
  maxInputImages: number; maxInputBytes: number; baseCreditCost: number; costLabel: string;
  pricingUrl?: string; licence: string; licenceStatus: string; licenceUrl: string; limitsNote: string;
  sources: string[]; verifiedOn: string; catalogueRevision: string; adapterRevision: string;
  developmentOnly?: boolean; retirementDate?: string;
};
export const modelCatalog = definitions as ModelDefinition[];
export function getModelById(id: string) { return modelCatalog.find((model) => model.id === id); }
export function canModelRunPixels(modelId: string, width: number, height: number) {
  const model = getModelById(modelId);
  return Boolean(model && (model.resolutions.length ? model.resolutions.some((size) => size.width === width && size.height === height) : width >= 256 && height >= 256 && width <= 1536 && height <= 1536));
}
export const removedCatalogueIds = ["gcp-openweight-xl", "gcp-fast-preview", "gcp-control-lab", "byok-provider-route", "vertex-imagen-studio", "vertex-gemini-llm"];
export function isUserCredentialProvider(providerId: string, route?: string) {
  // No specific external BYOK integration is implemented and reviewed yet.
  return providerId === "google-ai-studio" && route === "google-ai-studio-image";
}
