import catalogue from "./huggingface-models.json";
import { ollamaImageModelId } from "./ollama-image";

// The same file is copied into the inference and cache-preparation images.
export const huggingFaceImageModels = catalogue.models;
export const huggingFaceCatalogueSha256 = "8e6d29fa26321aaf9232249d77e5b13847e453e88cf3c6781bea9bd9272cb6fc";
export function huggingFaceImageModel(id: string) {
  return huggingFaceImageModels.find((model) => model.id === id);
}
export function isVisibleImageModel(id: string) {
  return id === ollamaImageModelId || Boolean(huggingFaceImageModel(id));
}
