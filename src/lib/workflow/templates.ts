import { huggingFaceImageModels } from "../models/huggingface-image";
import type { WorkflowDocument } from "./schema";

export type WorkflowTemplate = {
  id: string;
  name: string;
  category: "Text to image" | "Image to image" | "Product" | "Editorial" | "Multi-stage";
  modelId: string;
  creditEstimate: number;
  workflow: WorkflowDocument;
};

export const baseTextToImageWorkflow: WorkflowDocument = {
  schemaVersion: 3,
  selectedModel: "ollama-flux2-klein-4b-fp8",
  executionEnvironment: "gcp-hosted",
  nodes: [
    {
      id: "prompt",
      type: "prompt-input",
      position: { x: 80, y: 60 },
      data: {
        prompt: "A refined studio product composition with precise lighting, premium materials, and editorial polish."
      }
    },
    {
      id: "dimensions",
      type: "dimensions",
      position: { x: 320, y: 60 },
      data: { width: 1024, height: 1024, batch: 1 }
    },
    {
      id: "image_model",
      type: "text-to-image",
      position: { x: 580, y: 110 },
      execution: {
        timeoutSeconds: 900,
        retryPolicy: { maxAttempts: 2, backoffSeconds: 20, retryable: true },
        optional: false
      },
      data: {
        modelId: "ollama-flux2-klein-4b-fp8",
        route: "gcp-hosted-gpu",
        prompt: "",
        negativePrompt: "",
        width: 1024,
        height: 1024,
        batch: 1,
        outputFormat: "png",
        storagePolicy: { visibility: "private", retainIntermediate: true }
      }
    },
    {
      id: "safety",
      type: "safety-check",
      position: { x: 840, y: 110 },
      data: { contentPolicy: "standard", watermark: false }
    },
    {
      id: "output",
      type: "output",
      position: { x: 1080, y: 110 },
      data: { format: "png", privateByDefault: true, includeMetadata: true }
    }
  ],
  edges: [
    { id: "e-prompt-image", source: "prompt", sourceHandle: "text", target: "image_model", targetHandle: "prompt" },
    {
      id: "e-dimensions-image",
      source: "dimensions",
      sourceHandle: "dimensions",
      target: "image_model",
      targetHandle: "dimensions"
    },
    { id: "e-image-safety", source: "image_model", sourceHandle: "image", target: "safety", targetHandle: "image" },
    { id: "e-safety-output", source: "safety", sourceHandle: "approvedImage", target: "output", targetHandle: "image" }
  ]
};

export const multiStageReviewWorkflow: WorkflowDocument = {
  schemaVersion: 3,
  selectedModel: "development-fake-model",
  executionEnvironment: "development-local",
  nodes: [
    {
      id: "prompt",
      type: "prompt-input",
      position: { x: 70, y: 70 },
      data: { prompt: "Create a moody editorial watch campaign with rain-lit glass and crisp product detail." }
    },
    {
      id: "first_image",
      type: "text-to-image",
      position: { x: 330, y: 70 },
      execution: {
        timeoutSeconds: 600,
        retryPolicy: { maxAttempts: 2, backoffSeconds: 10, retryable: true },
        optional: false
      },
      data: {
        modelId: "development-fake-model",
        route: "development-fake",
        prompt: "",
        negativePrompt: "watermark, noisy text, warped logo",
        width: 768,
        height: 768,
        batch: 1,
        steps: 24,
        cfg: 6.5,
        sampler: "dpmpp-2m",
        scheduler: "karras",
        seed: 414208,
        deterministicSeed: true,
        outputFormat: "png",
        storagePolicy: { visibility: "private", retainIntermediate: true }
      }
    },
    {
      id: "caption",
      type: "image-analysis",
      position: { x: 600, y: 70 },
      execution: {
        timeoutSeconds: 240,
        retryPolicy: { maxAttempts: 2, backoffSeconds: 8, retryable: true },
        optional: false
      },
      data: {
        modelId: "development-fake-model",
        route: "development-fake",
        instruction: "Critique the image and extract a concise refinement prompt.",
        outputMode: "prompt-refinement",
        temperature: 0.2,
        maxOutputTokens: 700
      }
    },
    {
      id: "second_image",
      type: "text-to-image",
      position: { x: 870, y: 70 },
      execution: {
        timeoutSeconds: 600,
        retryPolicy: { maxAttempts: 2, backoffSeconds: 10, retryable: true },
        optional: false
      },
      data: {
        modelId: "development-fake-model",
        route: "development-fake",
        prompt: "Keep the strongest composition and improve the product clarity.",
        negativePrompt: "blur, low contrast, extra logo text",
        width: 768,
        height: 768,
        batch: 1,
        steps: 28,
        cfg: 7,
        sampler: "dpmpp-2m",
        scheduler: "karras",
        seed: 414209,
        deterministicSeed: true,
        outputFormat: "png",
        storagePolicy: { visibility: "private", retainIntermediate: true }
      }
    },
    {
      id: "safety",
      type: "safety-check",
      position: { x: 1140, y: 70 },
      data: { contentPolicy: "standard", watermark: false }
    },
    {
      id: "output",
      type: "output",
      position: { x: 1380, y: 70 },
      data: { format: "png", privateByDefault: true, includeMetadata: true }
    }
  ],
  edges: [
    { id: "e-prompt-first", source: "prompt", sourceHandle: "text", target: "first_image", targetHandle: "prompt" },
    { id: "e-first-caption", source: "first_image", sourceHandle: "image", target: "caption", targetHandle: "image" },
    { id: "e-caption-second", source: "caption", sourceHandle: "text", target: "second_image", targetHandle: "prompt" },
    { id: "e-second-safety", source: "second_image", sourceHandle: "image", target: "safety", targetHandle: "image" },
    { id: "e-safety-output", source: "safety", sourceHandle: "approvedImage", target: "output", targetHandle: "image" }
  ]
};

export const workflowTemplates: WorkflowTemplate[] = [{ id: "flux-klein-l4", name: "FLUX.2 Klein on L4", category: "Text to image", modelId: "ollama-flux2-klein-4b-fp8", creditEstimate: 6, workflow: baseTextToImageWorkflow }];

for (const model of huggingFaceImageModels) {
  const workflow = structuredClone(baseTextToImageWorkflow);
  workflow.selectedModel = model.id;
  workflow.executionEnvironment = "huggingface-l4";
  for (const node of workflow.nodes) {
    if (node.type === "text-to-image") { node.data.modelId = model.id; node.data.route = "huggingface-image"; }
  }
  workflowTemplates.push({ id: model.id + "-l4", name: model.name + " · Hugging Face L4", category: "Text to image", modelId: model.id, creditEstimate: 6, workflow });
}
