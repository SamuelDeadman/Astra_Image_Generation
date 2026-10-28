import {
  approvedNodeTypes,
  nodePorts,
  type ApprovedNodeType,
  type WorkflowDocument,
  type WorkflowNode
} from "./schema";

export type WorkflowIconKey =
  | "ban"
  | "brain"
  | "captions"
  | "file-image"
  | "image"
  | "message"
  | "paintbrush"
  | "ruler"
  | "shield"
  | "sliders";

export type WorkflowEditorFieldKind =
  | "asset-id"
  | "boolean"
  | "dimensions"
  | "enum"
  | "model"
  | "number"
  | "prompt"
  | "readonly-route"
  | "seed";

export type WorkflowEditorField = {
  key: string;
  label: string;
  kind: WorkflowEditorFieldKind;
};

type WorkflowNodeDefaultContext = {
  id: string;
  position: WorkflowNode["position"];
  selectedModel: WorkflowDocument["selectedModel"];
  seed: number;
};

export type WorkflowNodeDefinition<TType extends ApprovedNodeType = ApprovedNodeType> = {
  type: TType;
  label: string;
  eyebrow: string;
  catalogueLabel: string;
  catalogueDescription: string;
  iconKey: WorkflowIconKey;
  ports: (typeof nodePorts)[TType];
  contractDataKeys: readonly string[];
  editorFields: readonly WorkflowEditorField[];
  createDefaultNode(context: WorkflowNodeDefaultContext): Extract<WorkflowNode, { type: TType }>;
};

const imageGenerationFields = [
  { key: "modelId", label: "Model", kind: "model" },
  { key: "route", label: "Route", kind: "readonly-route" },
  { key: "prompt", label: "Inline prompt", kind: "prompt" },
  { key: "negativePrompt", label: "Negative prompt", kind: "prompt" },
  { key: "width", label: "Width", kind: "dimensions" },
  { key: "height", label: "Height", kind: "dimensions" },
  { key: "batch", label: "Batch", kind: "number" },
  { key: "steps", label: "Steps", kind: "number" },
  { key: "cfg", label: "CFG", kind: "number" },
  { key: "sampler", label: "Sampler", kind: "enum" },
  { key: "scheduler", label: "Scheduler", kind: "enum" },
  { key: "seed", label: "Seed", kind: "seed" },
  { key: "deterministicSeed", label: "Deterministic seed", kind: "boolean" },
  { key: "outputFormat", label: "Format", kind: "enum" },
  { key: "storagePolicy", label: "Storage", kind: "enum" }
] as const satisfies readonly WorkflowEditorField[];

const imageGenerationDataKeys = [
  "modelId",
  "route",
  "prompt",
  "negativePrompt",
  "width",
  "height",
  "batch",
  "steps",
  "cfg",
  "sampler",
  "scheduler",
  "seed",
  "deterministicSeed",
  "outputFormat",
  "storagePolicy"
] as const;

export const workflowNodeDefinitions = {
  "prompt-input": {
    type: "prompt-input",
    label: "Prompt Input",
    eyebrow: "Text",
    catalogueLabel: "Prompt",
    catalogueDescription: "Positive text",
    iconKey: "message",
    ports: nodePorts["prompt-input"],
    contractDataKeys: ["prompt"],
    editorFields: [{ key: "prompt", label: "Prompt", kind: "prompt" }],
    createDefaultNode: ({ id, position }) => ({
      id,
      type: "prompt-input",
      position,
      data: { prompt: "Describe the image you want AstraFlow to create." }
    })
  },
  "negative-prompt": {
    type: "negative-prompt",
    label: "Negative Prompt",
    eyebrow: "Text",
    catalogueLabel: "Negative",
    catalogueDescription: "Exclusions",
    iconKey: "ban",
    ports: nodePorts["negative-prompt"],
    contractDataKeys: ["prompt"],
    editorFields: [{ key: "prompt", label: "Prompt", kind: "prompt" }],
    createDefaultNode: ({ id, position }) => ({
      id,
      type: "negative-prompt",
      position,
      data: { prompt: "watermark, distorted hands, text artifacts" }
    })
  },
  "starting-image": {
    type: "starting-image",
    label: "Reference Image",
    eyebrow: "Input",
    catalogueLabel: "Reference",
    catalogueDescription: "Starting image",
    iconKey: "file-image",
    ports: nodePorts["starting-image"],
    contractDataKeys: ["assetId", "strength"],
    editorFields: [
      { key: "assetId", label: "Asset ID", kind: "asset-id" },
      { key: "strength", label: "Strength", kind: "number" }
    ],
    createDefaultNode: ({ id, position }) => ({
      id,
      type: "starting-image",
      position,
      data: { assetId: "upload-required", strength: 0.45 }
    })
  },
  dimensions: {
    type: "dimensions",
    label: "Dimensions",
    eyebrow: "Bounds",
    catalogueLabel: "Dimensions",
    catalogueDescription: "Size and batch",
    iconKey: "ruler",
    ports: nodePorts.dimensions,
    contractDataKeys: ["width", "height", "batch"],
    editorFields: [
      { key: "width", label: "Width", kind: "dimensions" },
      { key: "height", label: "Height", kind: "dimensions" },
      { key: "batch", label: "Batch", kind: "number" }
    ],
    createDefaultNode: ({ id, position }) => ({
      id,
      type: "dimensions",
      position,
      data: { width: 1024, height: 1024, batch: 1 }
    })
  },
  seed: {
    type: "seed",
    label: "Seed",
    eyebrow: "Control",
    catalogueLabel: "Seed",
    catalogueDescription: "Reusable randomness",
    iconKey: "sliders",
    ports: nodePorts.seed,
    contractDataKeys: ["seed", "locked"],
    editorFields: [
      { key: "seed", label: "Seed", kind: "seed" },
      { key: "locked", label: "Lock seed", kind: "boolean" }
    ],
    createDefaultNode: ({ id, position, seed }) => ({
      id,
      type: "seed",
      position,
      data: { seed, locked: false }
    })
  },
  "llm-prompt": {
    type: "llm-prompt",
    label: "LLM Prompt",
    eyebrow: "Language",
    catalogueLabel: "LLM Prompt",
    catalogueDescription: "Text and JSON reasoning",
    iconKey: "brain",
    ports: nodePorts["llm-prompt"],
    contractDataKeys: [
      "modelId",
      "route",
      "instruction",
      "systemPrompt",
      "outputMode",
      "jsonSchemaName",
      "temperature",
      "maxOutputTokens"
    ],
    editorFields: [
      { key: "modelId", label: "Model", kind: "model" },
      { key: "route", label: "Route", kind: "readonly-route" },
      { key: "instruction", label: "Instruction", kind: "prompt" },
      { key: "outputMode", label: "Output", kind: "enum" },
      { key: "temperature", label: "Temperature", kind: "number" },
      { key: "maxOutputTokens", label: "Max tokens", kind: "number" }
    ],
    createDefaultNode: ({ id, position, selectedModel }) => ({
      id,
      type: "llm-prompt",
      position,
      execution: { timeoutSeconds: 240, retryPolicy: { maxAttempts: 2, backoffSeconds: 8, retryable: true }, optional: false },
      data: {
        modelId: selectedModel,
        instruction: "Interpret the incoming prompt and produce a concise generation prompt.",
        outputMode: "text",
        temperature: 0.7,
        maxOutputTokens: 1024
      }
    })
  },
  "text-to-image": {
    type: "text-to-image",
    label: "Text to Image",
    eyebrow: "Image Model",
    catalogueLabel: "Text to Image",
    catalogueDescription: "Generate from prompt",
    iconKey: "sliders",
    ports: nodePorts["text-to-image"],
    contractDataKeys: imageGenerationDataKeys,
    editorFields: imageGenerationFields,
    createDefaultNode: ({ id, position, selectedModel, seed }) => ({
      id,
      type: "text-to-image",
      position,
      execution: { timeoutSeconds: 900, retryPolicy: { maxAttempts: 2, backoffSeconds: 20, retryable: true }, optional: false },
      data: {
        modelId: selectedModel,
        prompt: "",
        negativePrompt: "",
        width: 1024,
        height: 1024,
        batch: 1,
        steps: 30,
        cfg: 7,
        sampler: "dpmpp-2m",
        scheduler: "karras",
        seed,
        deterministicSeed: true,
        outputFormat: "png",
        storagePolicy: { visibility: "private", retainIntermediate: true }
      }
    })
  },
  "image-to-image": {
    type: "image-to-image",
    label: "Image to Image",
    eyebrow: "Image Model",
    catalogueLabel: "Image to Image",
    catalogueDescription: "Transform from image",
    iconKey: "image",
    ports: nodePorts["image-to-image"],
    contractDataKeys: [...imageGenerationDataKeys, "strength"],
    editorFields: [
      ...imageGenerationFields.slice(0, 7),
      { key: "strength", label: "Strength", kind: "number" },
      ...imageGenerationFields.slice(7)
    ],
    createDefaultNode: ({ id, position, selectedModel, seed }) => ({
      id,
      type: "image-to-image",
      position,
      execution: { timeoutSeconds: 900, retryPolicy: { maxAttempts: 2, backoffSeconds: 20, retryable: true }, optional: false },
      data: {
        modelId: selectedModel,
        prompt: "",
        negativePrompt: "",
        strength: 0.45,
        width: 1024,
        height: 1024,
        batch: 1,
        steps: 30,
        cfg: 7,
        sampler: "dpmpp-2m",
        scheduler: "karras",
        seed,
        deterministicSeed: true,
        outputFormat: "png",
        storagePolicy: { visibility: "private", retainIntermediate: true }
      }
    })
  },
  "image-analysis": {
    type: "image-analysis",
    label: "Image Analysis",
    eyebrow: "Vision",
    catalogueLabel: "Image Analysis",
    catalogueDescription: "Caption or critique",
    iconKey: "captions",
    ports: nodePorts["image-analysis"],
    contractDataKeys: ["modelId", "route", "instruction", "outputMode", "temperature", "maxOutputTokens"],
    editorFields: [
      { key: "modelId", label: "Model", kind: "model" },
      { key: "route", label: "Route", kind: "readonly-route" },
      { key: "instruction", label: "Instruction", kind: "prompt" },
      { key: "outputMode", label: "Output", kind: "enum" },
      { key: "temperature", label: "Temperature", kind: "number" },
      { key: "maxOutputTokens", label: "Max tokens", kind: "number" }
    ],
    createDefaultNode: ({ id, position, selectedModel }) => ({
      id,
      type: "image-analysis",
      position,
      execution: { timeoutSeconds: 240, retryPolicy: { maxAttempts: 2, backoffSeconds: 8, retryable: true }, optional: false },
      data: {
        modelId: selectedModel,
        instruction: "Caption, critique, or extract structured metadata from the image.",
        outputMode: "caption",
        temperature: 0.2,
        maxOutputTokens: 1024
      }
    })
  },
  "safety-check": {
    type: "safety-check",
    label: "Safety Check",
    eyebrow: "Policy",
    catalogueLabel: "Safety",
    catalogueDescription: "Moderation policy",
    iconKey: "shield",
    ports: nodePorts["safety-check"],
    contractDataKeys: ["contentPolicy", "watermark"],
    editorFields: [
      { key: "contentPolicy", label: "Policy", kind: "enum" },
      { key: "watermark", label: "Watermark", kind: "boolean" }
    ],
    createDefaultNode: ({ id, position }) => ({
      id,
      type: "safety-check",
      position,
      data: { contentPolicy: "standard", watermark: false }
    })
  },
  "image-transform": {
    type: "image-transform",
    label: "Image Transform",
    eyebrow: "Post",
    catalogueLabel: "Image Transform",
    catalogueDescription: "Upscale or convert",
    iconKey: "paintbrush",
    ports: nodePorts["image-transform"],
    contractDataKeys: ["modelId", "route", "operation", "scale", "outputFormat", "storagePolicy"],
    editorFields: [
      { key: "modelId", label: "Model", kind: "model" },
      { key: "route", label: "Route", kind: "readonly-route" },
      { key: "operation", label: "Operation", kind: "enum" },
      { key: "scale", label: "Scale", kind: "number" },
      { key: "outputFormat", label: "Format", kind: "enum" },
      { key: "storagePolicy", label: "Storage", kind: "enum" }
    ],
    createDefaultNode: ({ id, position }) => ({
      id,
      type: "image-transform",
      position,
      execution: { timeoutSeconds: 360, retryPolicy: { maxAttempts: 2, backoffSeconds: 10, retryable: true }, optional: false },
      data: {
        operation: "upscale",
        scale: 2,
        outputFormat: "png",
        storagePolicy: { visibility: "private", retainIntermediate: true }
      }
    })
  },
  output: {
    type: "output",
    label: "Output Asset",
    eyebrow: "Storage",
    catalogueLabel: "Output",
    catalogueDescription: "Private asset",
    iconKey: "shield",
    ports: nodePorts.output,
    contractDataKeys: ["format", "privateByDefault", "includeMetadata"],
    editorFields: [
      { key: "format", label: "Format", kind: "enum" },
      { key: "privateByDefault", label: "Private by default", kind: "boolean" }
    ],
    createDefaultNode: ({ id, position }) => ({
      id,
      type: "output",
      position,
      data: { format: "png", privateByDefault: true, includeMetadata: true }
    })
  }
} satisfies { [TType in ApprovedNodeType]: WorkflowNodeDefinition<TType> };

export const workflowNodeCatalogue = approvedNodeTypes.map((type) => workflowNodeDefinitions[type]);

export function getWorkflowNodeDefinition<TType extends ApprovedNodeType>(type: TType) {
  return workflowNodeDefinitions[type];
}
