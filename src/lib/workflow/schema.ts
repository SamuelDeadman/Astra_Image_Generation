import { z } from "zod";
import { workflowModelConstraintIssues } from "../models/constraints";

export const workflowSchemaVersion = 3;

export const workflowLimits = {
  maxNodes: 40,
  maxEdges: 100,
  maxFanOut: 8,
  maxWidth: 4096,
  maxHeight: 4096,
  maxPixels: 4096 * 4096,
  maxSteps: 80,
  maxBatch: 4,
  maxPromptLength: 4000,
  maxNegativePromptLength: 3000,
  maxJsonSchemaNameLength: 80,
  maxTimeoutSeconds: 1800,
  maxNodeAttempts: 5,
  maxTotalEstimatedSeconds: 3600
} as const;

export const providerRouteValues = [
  "vertex-llm",
  "vertex-image",
  "google-ai-studio-image",
  "gcp-hosted-gpu",
  "huggingface-image",
  "external-byok",
  "development-fake"
] as const;

export type ProviderRoute = (typeof providerRouteValues)[number];

export const workflowExecutionEnvironmentValues = [
  "gcp-hosted",
  "huggingface-l4",
  "google-ai-studio",
  "external-byok",
  "development-local"
] as const;

export type WorkflowExecutionEnvironment = (typeof workflowExecutionEnvironmentValues)[number];

export const defaultWorkflowExecutionEnvironment: WorkflowExecutionEnvironment = "gcp-hosted";

export const approvedNodeTypes = [
  "prompt-input",
  "negative-prompt",
  "starting-image",
  "dimensions",
  "seed",
  "llm-prompt",
  "text-to-image",
  "image-to-image",
  "image-analysis",
  "safety-check",
  "image-transform",
  "output"
] as const;

export type ApprovedNodeType = (typeof approvedNodeTypes)[number];

export type PortType = "text" | "image" | "json" | "dimensions" | "seed";

const identifierSchema = z.string().min(1).max(80).regex(/^[a-zA-Z0-9_-]+$/);
const edgeIdentifierSchema = z.string().min(1).max(120).regex(/^[a-zA-Z0-9_-]+$/);
const modelIdentifierSchema = z.string().min(1).max(140).regex(/^[a-zA-Z0-9_.:-]+$/);
const assetIdentifierSchema = z.string().min(1).max(140).regex(/^[a-zA-Z0-9_-]+$/);
const promptSchema = z.string().min(1).max(workflowLimits.maxPromptLength);
const optionalPromptSchema = z.string().max(workflowLimits.maxPromptLength).default("");
const negativePromptSchema = z.string().max(workflowLimits.maxNegativePromptLength).default("");

const positionSchema = z.object({
  x: z.number().finite(),
  y: z.number().finite()
});

const retryPolicySchema = z
  .object({
    maxAttempts: z.number().int().min(1).max(workflowLimits.maxNodeAttempts).default(1),
    backoffSeconds: z.number().int().min(1).max(600).default(10),
    retryable: z.boolean().default(true)
  })
  .strict();

const executionPolicySchema = z
  .object({
    timeoutSeconds: z.number().int().min(5).max(workflowLimits.maxTimeoutSeconds).default(300),
    retryPolicy: retryPolicySchema.default({}),
    optional: z.boolean().default(false)
  })
  .strict();

const storagePolicySchema = z
  .object({
    visibility: z.literal("private").default("private"),
    retainIntermediate: z.boolean().default(true)
  })
  .strict();

const imageSizeSchema = {
  width: z.number().int().min(256).max(workflowLimits.maxWidth).default(1024),
  height: z.number().int().min(256).max(workflowLimits.maxHeight).default(1024),
  batch: z.number().int().min(1).max(workflowLimits.maxBatch).default(1)
} as const;

const imageInferenceControlsSchema = {
  steps: z.number().int().min(1).max(workflowLimits.maxSteps).optional(),
  cfg: z.number().min(0).max(30).optional(),
  sampler: z.enum(["euler", "euler-a", "dpmpp-2m", "dpmpp-sde", "uni-pc"]).optional(),
  scheduler: z.enum(["normal", "karras", "exponential", "sgm-uniform"]).optional(),
  seed: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER).optional(),
  deterministicSeed: z.boolean().optional()
} as const;

const outputFormatSchema = z.enum(["png", "webp", "jpeg"]).default("png");
const routeHintSchema = z.enum(providerRouteValues).optional();
const executionEnvironmentSchema = z.enum(workflowExecutionEnvironmentValues);

const baseNodeSchema = z.object({
  id: identifierSchema,
  position: positionSchema,
  label: z.string().min(1).max(80).optional(),
  execution: executionPolicySchema.optional()
});

const promptInputNodeSchema = baseNodeSchema.extend({
  type: z.literal("prompt-input"),
  data: z
    .object({
      prompt: promptSchema
    })
    .strict()
});

const negativePromptNodeSchema = baseNodeSchema.extend({
  type: z.literal("negative-prompt"),
  data: z
    .object({
      prompt: negativePromptSchema
    })
    .strict()
});

const startingImageNodeSchema = baseNodeSchema.extend({
  type: z.literal("starting-image"),
  data: z
    .object({
      assetId: assetIdentifierSchema,
      strength: z.number().min(0).max(1).default(0.45)
    })
    .strict()
});

const dimensionsNodeSchema = baseNodeSchema.extend({
  type: z.literal("dimensions"),
  data: z
    .object({
      ...imageSizeSchema
    })
    .strict()
});

const seedNodeSchema = baseNodeSchema.extend({
  type: z.literal("seed"),
  data: z
    .object({
      seed: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
      locked: z.boolean().default(false)
    })
    .strict()
});

const llmPromptNodeSchema = baseNodeSchema.extend({
  type: z.literal("llm-prompt"),
  data: z
    .object({
      modelId: modelIdentifierSchema,
      route: routeHintSchema,
      instruction: promptSchema,
      systemPrompt: z.string().max(2000).optional(),
      outputMode: z.enum(["text", "json"]).default("text"),
      jsonSchemaName: z.string().min(1).max(workflowLimits.maxJsonSchemaNameLength).optional(),
      temperature: z.number().min(0).max(2).default(0.7),
      maxOutputTokens: z.number().int().min(1).max(4096).default(1024)
    })
    .strict()
});

const textToImageNodeSchema = baseNodeSchema.extend({
  type: z.literal("text-to-image"),
  data: z
    .object({
      modelId: modelIdentifierSchema,
      route: routeHintSchema,
      prompt: optionalPromptSchema,
      negativePrompt: negativePromptSchema,
      ...imageSizeSchema,
      ...imageInferenceControlsSchema,
      outputFormat: outputFormatSchema,
      storagePolicy: storagePolicySchema.default({})
    })
    .strict()
});

const imageToImageNodeSchema = baseNodeSchema.extend({
  type: z.literal("image-to-image"),
  data: z
    .object({
      modelId: modelIdentifierSchema,
      route: routeHintSchema,
      prompt: optionalPromptSchema,
      negativePrompt: negativePromptSchema,
      strength: z.number().min(0).max(1).optional(),
      ...imageSizeSchema,
      ...imageInferenceControlsSchema,
      outputFormat: outputFormatSchema,
      storagePolicy: storagePolicySchema.default({})
    })
    .strict()
});

const imageAnalysisNodeSchema = baseNodeSchema.extend({
  type: z.literal("image-analysis"),
  data: z
    .object({
      modelId: modelIdentifierSchema,
      route: routeHintSchema,
      instruction: promptSchema,
      outputMode: z.enum(["caption", "critique", "ranking", "metadata-json", "prompt-refinement"]).default("caption"),
      temperature: z.number().min(0).max(2).default(0.2),
      maxOutputTokens: z.number().int().min(1).max(4096).default(1024)
    })
    .strict()
});

const safetyNodeSchema = baseNodeSchema.extend({
  type: z.literal("safety-check"),
  data: z
    .object({
      contentPolicy: z.enum(["standard", "strict"]),
      watermark: z.boolean().default(false)
    })
    .strict()
});

const imageTransformNodeSchema = baseNodeSchema.extend({
  type: z.literal("image-transform"),
  data: z
    .object({
      modelId: modelIdentifierSchema.optional(),
      route: routeHintSchema,
      operation: z.enum(["upscale", "background-remove", "format-convert", "thumbnail"]).default("upscale"),
      scale: z.number().min(1).max(4).default(2),
      outputFormat: outputFormatSchema,
      storagePolicy: storagePolicySchema.default({})
    })
    .strict()
});

const outputNodeSchema = baseNodeSchema.extend({
  type: z.literal("output"),
  data: z
    .object({
      format: outputFormatSchema,
      privateByDefault: z.boolean().default(true),
      includeMetadata: z.boolean().default(true)
    })
    .strict()
});

export const workflowNodeSchema = z.discriminatedUnion("type", [
  promptInputNodeSchema,
  negativePromptNodeSchema,
  startingImageNodeSchema,
  dimensionsNodeSchema,
  seedNodeSchema,
  llmPromptNodeSchema,
  textToImageNodeSchema,
  imageToImageNodeSchema,
  imageAnalysisNodeSchema,
  safetyNodeSchema,
  imageTransformNodeSchema,
  outputNodeSchema
]);

export const workflowEdgeSchema = z
  .object({
    id: edgeIdentifierSchema,
    source: identifierSchema,
    sourceHandle: identifierSchema,
    target: identifierSchema,
    targetHandle: identifierSchema
  })
  .strict();

const workflowV3RawSchema = z
  .object({
    schemaVersion: z.literal(workflowSchemaVersion),
    selectedModel: modelIdentifierSchema.optional(),
    executionEnvironment: executionEnvironmentSchema.optional(),
    nodes: z.array(workflowNodeSchema).min(1).max(workflowLimits.maxNodes),
    edges: z.array(workflowEdgeSchema).max(workflowLimits.maxEdges)
  })
  .strict();

const workflowV2RawSchema = z
  .object({
    schemaVersion: z.literal(2),
    selectedModel: modelIdentifierSchema.optional(),
    nodes: z.array(workflowNodeSchema).min(1).max(workflowLimits.maxNodes),
    edges: z.array(workflowEdgeSchema).max(workflowLimits.maxEdges)
  })
  .strict();

type WorkflowDocumentRaw = z.infer<typeof workflowV3RawSchema>;
type WorkflowV2DocumentRaw = z.infer<typeof workflowV2RawSchema>;
export type WorkflowNode = z.infer<typeof workflowNodeSchema>;
export type WorkflowEdge = z.infer<typeof workflowEdgeSchema>;
export type WorkflowDocument = Omit<WorkflowDocumentRaw, "selectedModel"> & {
  selectedModel: string;
  executionEnvironment: WorkflowExecutionEnvironment;
};

const legacyBaseNodeSchema = z.object({
  id: identifierSchema,
  position: positionSchema
});

const legacyWorkflowNodeSchema = z.discriminatedUnion("type", [
  legacyBaseNodeSchema.extend({
    type: z.literal("model"),
    data: z.object({ modelId: modelIdentifierSchema }).strict()
  }),
  legacyBaseNodeSchema.extend({
    type: z.literal("positive-prompt"),
    data: z.object({ prompt: promptSchema }).strict()
  }),
  negativePromptNodeSchema.omit({ execution: true, label: true }).extend({ type: z.literal("negative-prompt") }),
  startingImageNodeSchema.omit({ execution: true, label: true }).extend({ type: z.literal("starting-image") }),
  dimensionsNodeSchema.omit({ execution: true, label: true }).extend({ type: z.literal("dimensions") }),
  seedNodeSchema.omit({ execution: true, label: true }).extend({ type: z.literal("seed") }),
  legacyBaseNodeSchema.extend({
    type: z.literal("sampler"),
    data: z
      .object({
        steps: z.number().int().min(1).max(workflowLimits.maxSteps),
        cfg: z.number().min(0).max(30),
        sampler: z.enum(["euler", "euler-a", "dpmpp-2m", "dpmpp-sde", "uni-pc"]),
        scheduler: z.enum(["normal", "karras", "exponential", "sgm-uniform"])
      })
      .strict()
  }),
  safetyNodeSchema.omit({ execution: true, label: true }).extend({ type: z.literal("safety-check") }),
  outputNodeSchema.omit({ execution: true, label: true }).extend({ type: z.literal("output") })
]);

const legacyWorkflowSchema = z
  .object({
    schemaVersion: z.literal(1),
    selectedModel: modelIdentifierSchema,
    nodes: z.array(legacyWorkflowNodeSchema).min(1).max(workflowLimits.maxNodes),
    edges: z.array(workflowEdgeSchema).max(workflowLimits.maxEdges)
  })
  .strict();

type LegacyWorkflowDocument = z.infer<typeof legacyWorkflowSchema>;
type LegacyWorkflowNode = z.infer<typeof legacyWorkflowNodeSchema>;

export const nodePorts: Record<ApprovedNodeType, { outputs: Record<string, PortType>; inputs: Record<string, PortType> }> = {
  "prompt-input": {
    inputs: {},
    outputs: { text: "text" }
  },
  "negative-prompt": {
    inputs: {},
    outputs: { text: "text" }
  },
  "starting-image": {
    inputs: {},
    outputs: { image: "image" }
  },
  dimensions: {
    inputs: {},
    outputs: { dimensions: "dimensions" }
  },
  seed: {
    inputs: {},
    outputs: { seed: "seed" }
  },
  "llm-prompt": {
    inputs: { prompt: "text", context: "text", image: "image", json: "json" },
    outputs: { text: "text", json: "json" }
  },
  "text-to-image": {
    inputs: { prompt: "text", negative: "text", dimensions: "dimensions", seed: "seed", metadata: "json" },
    outputs: { image: "image", metadata: "json" }
  },
  "image-to-image": {
    inputs: { prompt: "text", negative: "text", image: "image", dimensions: "dimensions", seed: "seed", metadata: "json" },
    outputs: { image: "image", metadata: "json" }
  },
  "image-analysis": {
    inputs: { image: "image", prompt: "text", metadata: "json" },
    outputs: { text: "text", json: "json" }
  },
  "safety-check": {
    inputs: { image: "image", text: "text", metadata: "json" },
    outputs: { approvedImage: "image", safety: "json" }
  },
  "image-transform": {
    inputs: { image: "image", prompt: "text", metadata: "json" },
    outputs: { image: "image", metadata: "json" }
  },
  output: {
    inputs: { image: "image", text: "text", json: "json", metadata: "json" },
    outputs: {}
  }
};

export const executableNodeTypes = [
  "llm-prompt",
  "text-to-image",
  "image-to-image",
  "image-analysis",
  "safety-check",
  "image-transform",
  "output"
] as const satisfies ApprovedNodeType[];

export type ExecutableNodeType = (typeof executableNodeTypes)[number];

export type WorkflowValidationResult =
  | {
      ok: true;
      workflow: WorkflowDocument;
      warnings: string[];
    }
  | {
      ok: false;
      issues: string[];
    };

export type ValidationModelContext = {
  id: string;
  name: string;
  route?: ProviderRoute | string;
  maxPixels: number;
  maxSteps?: number;
  baseCreditCost?: number;
  isEnabled?: boolean;
  capabilities?: unknown;
};

function hasModelId(node: WorkflowNode): node is WorkflowNode & { data: WorkflowNode["data"] & { modelId: string } } {
  return "modelId" in node.data && typeof node.data.modelId === "string" && node.data.modelId.length > 0;
}

function firstModelId(workflow: WorkflowDocumentRaw | WorkflowV2DocumentRaw) {
  return workflow.nodes.find(hasModelId)?.data.modelId ?? workflow.selectedModel ?? "model-unresolved";
}

function routeHintExecutionEnvironment(route: ProviderRoute): WorkflowExecutionEnvironment | null {
  if (route === "huggingface-image") return "huggingface-l4";
  if (route === "gcp-hosted-gpu") {
    return "gcp-hosted";
  }

  if (route === "google-ai-studio-image") {
    return "google-ai-studio";
  }

  if (route === "external-byok") {
    return "external-byok";
  }

  return null;
}

function inferredExecutionEnvironment(workflow: WorkflowDocumentRaw | WorkflowV2DocumentRaw): WorkflowExecutionEnvironment {
  if ("executionEnvironment" in workflow && workflow.executionEnvironment) {
    return workflow.executionEnvironment;
  }

  const hinted = Array.from(
    new Set(
      workflow.nodes
        .map((node) => ("route" in node.data ? node.data.route : undefined))
        .filter((route): route is ProviderRoute => Boolean(route))
        .map(routeHintExecutionEnvironment)
        .filter((environment): environment is WorkflowExecutionEnvironment => Boolean(environment))
    )
  );

  return hinted.length === 1 ? hinted[0] : defaultWorkflowExecutionEnvironment;
}

function normalizeModernWorkflow(workflow: WorkflowDocumentRaw | WorkflowV2DocumentRaw): WorkflowDocument {
  return {
    ...workflow,
    schemaVersion: workflowSchemaVersion,
    executionEnvironment: inferredExecutionEnvironment(workflow),
    selectedModel: workflow.selectedModel ?? firstModelId(workflow)
  };
}

function legacyNode<TType extends LegacyWorkflowNode["type"]>(
  workflow: LegacyWorkflowDocument,
  type: TType
): Extract<LegacyWorkflowNode, { type: TType }> | undefined {
  return workflow.nodes.find((node): node is Extract<LegacyWorkflowNode, { type: TType }> => node.type === type);
}

function migrateLegacyWorkflow(workflow: LegacyWorkflowDocument): WorkflowDocument {
  const positive = legacyNode(workflow, "positive-prompt");
  const negative = legacyNode(workflow, "negative-prompt");
  const dimensions = legacyNode(workflow, "dimensions");
  const seed = legacyNode(workflow, "seed");
  const sampler = legacyNode(workflow, "sampler");
  const safety = legacyNode(workflow, "safety-check");
  const output = legacyNode(workflow, "output");
  const startingImage = legacyNode(workflow, "starting-image");
  const imageNodeId = sampler?.id ?? "image_model";
  const imageNodeType = startingImage ? "image-to-image" : "text-to-image";
  const nodes: WorkflowNode[] = [
    {
      id: positive?.id ?? "prompt",
      type: "prompt-input",
      position: positive?.position ?? { x: 80, y: 80 },
      data: { prompt: positive?.data.prompt ?? "Describe the image you want AstraFlow to create." }
    },
    {
      id: negative?.id ?? "negative",
      type: "negative-prompt",
      position: negative?.position ?? { x: 80, y: 210 },
      data: { prompt: negative?.data.prompt ?? "" }
    },
    {
      id: dimensions?.id ?? "dimensions",
      type: "dimensions",
      position: dimensions?.position ?? { x: 320, y: 80 },
      data: dimensions?.data ?? { width: 1024, height: 1024, batch: 1 }
    },
    {
      id: seed?.id ?? "seed",
      type: "seed",
      position: seed?.position ?? { x: 320, y: 210 },
      data: seed?.data ?? { seed: 0, locked: false }
    },
    {
      id: imageNodeId,
      type: imageNodeType,
      position: sampler?.position ?? { x: 580, y: 120 },
      data: {
        modelId: workflow.selectedModel,
        prompt: "",
        negativePrompt: "",
        width: dimensions?.data.width ?? 1024,
        height: dimensions?.data.height ?? 1024,
        batch: dimensions?.data.batch ?? 1,
        seed: seed?.data.seed ?? 0,
        deterministicSeed: true,
        steps: sampler?.data.steps ?? 30,
        cfg: sampler?.data.cfg ?? 7,
        sampler: sampler?.data.sampler ?? "dpmpp-2m",
        scheduler: sampler?.data.scheduler ?? "karras",
        ...(startingImage ? { strength: startingImage.data.strength } : {}),
        outputFormat: output?.data.format ?? "png",
        storagePolicy: { visibility: "private", retainIntermediate: true }
      }
    } as WorkflowNode
  ];

  if (startingImage) {
    nodes.splice(2, 0, {
      id: startingImage.id,
      type: "starting-image",
      position: startingImage.position,
      data: startingImage.data
    });
  }

  nodes.push(
    {
      id: safety?.id ?? "safety",
      type: "safety-check",
      position: safety?.position ?? { x: 840, y: 120 },
      data: safety?.data ?? { contentPolicy: "standard", watermark: false }
    },
    {
      id: output?.id ?? "output",
      type: "output",
      position: output?.position ?? { x: 1080, y: 120 },
      data: output?.data ?? { format: "png", privateByDefault: true, includeMetadata: true }
    }
  );

  const edges: WorkflowEdge[] = [
    { id: "e-prompt-image", source: positive?.id ?? "prompt", sourceHandle: "text", target: imageNodeId, targetHandle: "prompt" },
    { id: "e-negative-image", source: negative?.id ?? "negative", sourceHandle: "text", target: imageNodeId, targetHandle: "negative" },
    { id: "e-dimensions-image", source: dimensions?.id ?? "dimensions", sourceHandle: "dimensions", target: imageNodeId, targetHandle: "dimensions" },
    { id: "e-seed-image", source: seed?.id ?? "seed", sourceHandle: "seed", target: imageNodeId, targetHandle: "seed" },
    { id: "e-image-safety", source: imageNodeId, sourceHandle: "image", target: safety?.id ?? "safety", targetHandle: "image" },
    { id: "e-safety-output", source: safety?.id ?? "safety", sourceHandle: "approvedImage", target: output?.id ?? "output", targetHandle: "image" }
  ];

  if (startingImage) {
    edges.unshift({
      id: "e-starting-image-model",
      source: startingImage.id,
      sourceHandle: "image",
      target: imageNodeId,
      targetHandle: "image"
    });
  }

  return {
    schemaVersion: workflowSchemaVersion,
    selectedModel: workflow.selectedModel,
    executionEnvironment: defaultWorkflowExecutionEnvironment,
    nodes,
    edges
  };
}

export function normalizeWorkflowDocument(input: unknown): WorkflowValidationResult {
  const parsed = z.union([workflowV3RawSchema, workflowV2RawSchema, legacyWorkflowSchema]).safeParse(input);

  if (!parsed.success) {
    return {
      ok: false,
      issues: parsed.error.issues.map((issue) => `${issue.path.join(".") || "workflow"}: ${issue.message}`)
    };
  }

  const workflow =
    parsed.data.schemaVersion === 1 ? migrateLegacyWorkflow(parsed.data) : normalizeModernWorkflow(parsed.data);
  const result = validateWorkflowStructure(workflow);

  if (!result.ok) {
    return result;
  }

  const warnings = [...result.warnings];

  if (parsed.data.schemaVersion === 1) {
    warnings.push(`Workflow was migrated from schema version 1 to ${workflowSchemaVersion}.`);
  } else if (parsed.data.schemaVersion !== workflowSchemaVersion) {
    warnings.push(`Workflow was migrated from schema version ${parsed.data.schemaVersion} to ${workflowSchemaVersion}.`);
  }

  if (parsed.data.schemaVersion !== 1 && !parsed.data.selectedModel) {
    warnings.push("Workflow selectedModel was filled from the first model node for compatibility.");
  }

  if (parsed.data.schemaVersion !== 1 && !("executionEnvironment" in parsed.data && parsed.data.executionEnvironment)) {
    warnings.push(`Workflow executionEnvironment was set to ${workflow.executionEnvironment}.`);
  }

  return {
    ...result,
    warnings
  };
}

export const workflowSchema = workflowV3RawSchema.transform(normalizeModernWorkflow);

function incomingByTarget(workflow: WorkflowDocument) {
  const incoming = new Map<string, WorkflowEdge[]>();

  for (const edge of workflow.edges) {
    const bucket = incoming.get(edge.target) ?? [];
    bucket.push(edge);
    incoming.set(edge.target, bucket);
  }

  return incoming;
}

function outgoingBySourceHandle(workflow: WorkflowDocument) {
  const outgoing = new Map<string, number>();

  for (const edge of workflow.edges) {
    const key = `${edge.source}:${edge.sourceHandle}`;
    outgoing.set(key, (outgoing.get(key) ?? 0) + 1);
  }

  return outgoing;
}

function hasIncomingHandle(incoming: Map<string, WorkflowEdge[]>, nodeId: string, handle: string) {
  return (incoming.get(nodeId) ?? []).some((edge) => edge.targetHandle === handle);
}

function detectCycles(workflow: WorkflowDocument) {
  const adjacency = new Map<string, string[]>();

  for (const node of workflow.nodes) {
    adjacency.set(node.id, []);
  }

  for (const edge of workflow.edges) {
    adjacency.get(edge.source)?.push(edge.target);
  }

  const visiting = new Set<string>();
  const visited = new Set<string>();
  const cycles: string[] = [];

  function visit(nodeId: string, path: string[]) {
    if (visiting.has(nodeId)) {
      cycles.push([...path, nodeId].join(" -> "));
      return;
    }

    if (visited.has(nodeId)) {
      return;
    }

    visiting.add(nodeId);

    for (const next of adjacency.get(nodeId) ?? []) {
      visit(next, [...path, nodeId]);
    }

    visiting.delete(nodeId);
    visited.add(nodeId);
  }

  for (const node of workflow.nodes) {
    visit(node.id, []);
  }

  return cycles;
}

function capabilityList(capabilities: unknown) {
  return Array.isArray(capabilities) ? capabilities.filter((capability): capability is string => typeof capability === "string") : [];
}

function routeSupportsNode(route: string | undefined, node: WorkflowNode) {
  if (!route) {
    return true;
  }

  if (route === "development-fake") {
    return true;
  }

  if (node.type === "llm-prompt" || node.type === "image-analysis") {
    return route === "vertex-llm" || route === "external-byok";
  }

  if (node.type === "text-to-image" || node.type === "image-to-image") {
    return (node.type === "text-to-image" && route === "huggingface-image") || route === "vertex-image" || route === "google-ai-studio-image" || route === "gcp-hosted-gpu" || route === "external-byok";
  }

  if (node.type === "image-transform") {
    return route === "gcp-hosted-gpu" || route === "external-byok";
  }

  return true;
}

function routeSupportsExecutionEnvironment(route: string | undefined, environment: WorkflowExecutionEnvironment) {
  if (!route) {
    return true;
  }

  if (environment === "huggingface-l4") return route === "huggingface-image";

  if (environment === "gcp-hosted") {
    return route === "gcp-hosted-gpu";
  }

  if (environment === "google-ai-studio") {
    return route === "google-ai-studio-image";
  }

  if (environment === "external-byok") {
    return route === "external-byok";
  }

  return route === "development-fake";
}

function modelSupportsNode(model: ValidationModelContext, node: WorkflowNode) {
  const capabilities = capabilityList(model.capabilities);

  if (model.isEnabled === false) {
    return false;
  }

  if (!routeSupportsNode(model.route, node)) {
    return false;
  }

  if (node.type === "llm-prompt") {
    return capabilities.length === 0 || capabilities.includes("llm");
  }

  if (node.type === "image-analysis") {
    return capabilities.length === 0 || capabilities.includes("vision") || capabilities.includes("image-analysis");
  }

  if (node.type === "text-to-image") {
    return capabilities.length === 0 || capabilities.includes("text-to-image");
  }

  if (node.type === "image-to-image") {
    return capabilities.length === 0 || capabilities.includes("image-to-image");
  }

  if (node.type === "image-transform") {
    return (
      !node.data.modelId ||
      capabilities.length === 0 ||
      capabilities.includes("image-transform") ||
      capabilities.includes(node.data.operation)
    );
  }

  return true;
}

function imageNodePixels(node: WorkflowNode) {
  if (node.type === "text-to-image" || node.type === "image-to-image") {
    return {
      pixels: node.data.width * node.data.height,
      steps: node.data.steps,
      batch: node.data.batch
    };
  }

  return null;
}

function validateWorkflowStructure(workflow: WorkflowDocument): WorkflowValidationResult {
  const issues: string[] = [];
  const warnings: string[] = [];
  const nodeIds = new Set<string>();
  const edgeIds = new Set<string>();
  const nodesById = new Map<string, WorkflowNode>();

  for (const node of workflow.nodes) {
    if (nodeIds.has(node.id)) {
      issues.push(`Duplicate node id: ${node.id}`);
    }
    nodeIds.add(node.id);
    nodesById.set(node.id, node);

    const controls = imageNodePixels(node);
    if (controls) {
      if (controls.pixels > workflowLimits.maxPixels) {
        issues.push(`Image node ${node.id} exceeds maximum pixel budget.`);
      }
      if ((controls.steps ?? 1) > workflowLimits.maxSteps) {
        issues.push(`Image node ${node.id} exceeds maximum step budget.`);
      }
      if (controls.batch > workflowLimits.maxBatch) {
        issues.push(`Image node ${node.id} exceeds maximum batch budget.`);
      }
    }

    if (node.type === "output" && node.data.privateByDefault !== true) {
      issues.push(`Output node ${node.id} must keep generated assets private by default.`);
    }
  }

  const incoming = incomingByTarget(workflow);
  const outgoingCounts = outgoingBySourceHandle(workflow);
  const occupiedTargets = new Set<string>();

  for (const edge of workflow.edges) {
    if (edgeIds.has(edge.id)) {
      issues.push(`Duplicate edge id: ${edge.id}`);
    }
    edgeIds.add(edge.id);

    if (edge.source === edge.target) {
      issues.push(`Edge ${edge.id} connects a node to itself.`);
      continue;
    }

    const source = nodesById.get(edge.source);
    const target = nodesById.get(edge.target);

    if (!source || !target) {
      issues.push(`Edge ${edge.id} references a missing node.`);
      continue;
    }

    const sourceType = nodePorts[source.type].outputs[edge.sourceHandle];
    const targetType = nodePorts[target.type].inputs[edge.targetHandle];

    if (!sourceType) {
      issues.push(`Edge ${edge.id} uses invalid source handle ${edge.sourceHandle}.`);
      continue;
    }

    if (!targetType) {
      issues.push(`Edge ${edge.id} uses invalid target handle ${edge.targetHandle}.`);
      continue;
    }

    if (sourceType !== targetType) {
      issues.push(`Edge ${edge.id} connects ${sourceType} output to ${targetType} input.`);
    }

    const targetKey = `${edge.target}:${edge.targetHandle}`;
    if (occupiedTargets.has(targetKey)) {
      issues.push(`Input ${edge.target}.${edge.targetHandle} has more than one connection.`);
    }
    occupiedTargets.add(targetKey);
  }

  for (const [sourceHandle, count] of outgoingCounts.entries()) {
    if (count > workflowLimits.maxFanOut) {
      issues.push(`Output ${sourceHandle} exceeds maximum fan-out of ${workflowLimits.maxFanOut}.`);
    }
  }

  for (const cycle of detectCycles(workflow)) {
    issues.push(`Workflow contains a cycle: ${cycle}`);
  }

  for (const node of workflow.nodes) {
    if (node.type === "text-to-image" && !node.data.prompt.trim() && !hasIncomingHandle(incoming, node.id, "prompt")) {
      issues.push(`Text-to-image node ${node.id} requires a prompt input or node prompt.`);
    }

    if (node.type === "image-to-image") {
      if (!hasIncomingHandle(incoming, node.id, "image")) {
        issues.push(`Image-to-image node ${node.id} requires an image input.`);
      }

      if (!node.data.prompt.trim() && !hasIncomingHandle(incoming, node.id, "prompt")) {
        issues.push(`Image-to-image node ${node.id} requires a prompt input or node prompt.`);
      }
    }

    if (node.type === "image-analysis" && !hasIncomingHandle(incoming, node.id, "image")) {
      issues.push(`Image analysis node ${node.id} requires an image input.`);
    }

    if (node.type === "safety-check" && !hasIncomingHandle(incoming, node.id, "image")) {
      issues.push(`Safety node ${node.id} requires an image input.`);
    }

    if (node.type === "image-transform" && !hasIncomingHandle(incoming, node.id, "image")) {
      issues.push(`Image transform node ${node.id} requires an image input.`);
    }

    if (node.type === "output" && (incoming.get(node.id) ?? []).length === 0) {
      issues.push(`Output node ${node.id} requires at least one input.`);
    }
  }

  if (!workflow.nodes.some((node) => node.type === "text-to-image" || node.type === "image-to-image")) {
    issues.push("Workflow must include at least one image model action.");
  }

  if (!workflow.nodes.some((node) => node.type === "output")) {
    issues.push("Workflow must include an output node.");
  }

  if (workflow.schemaVersion !== workflowSchemaVersion) {
    warnings.push(`Workflow was normalized to schema version ${workflowSchemaVersion}.`);
  }

  if (issues.length > 0) {
    return { ok: false, issues };
  }

  return { ok: true, workflow, warnings };
}

export function validateWorkflow(
  input: unknown,
  options?: {
    model?: ValidationModelContext;
    models?: ValidationModelContext[];
    allowDevelopmentLocal?: boolean;
    nodeEnv?: string;
  }
): WorkflowValidationResult {
  const normalized = normalizeWorkflowDocument(input);

  if (!normalized.ok) {
    return normalized;
  }

  const workflow = normalized.workflow;
  const issues: string[] = workflowModelConstraintIssues(workflow).map((entry) => entry.message);
  const warnings = [...normalized.warnings];
  const modelContexts = new Map<string, ValidationModelContext>();
  const nodeEnv = options?.nodeEnv ?? process.env.NODE_ENV;
  const allowDevelopmentLocal = options?.allowDevelopmentLocal ?? nodeEnv !== "production";

  if ((workflow.executionEnvironment === "development-local" || workflow.nodes.some((node) => hasModelId(node) && (node.data.modelId === "development-fake-model" || ("route" in node.data && node.data.route === "development-fake")))) && !allowDevelopmentLocal) {
    issues.push("Development-local execution is disabled in production.");
  }

  if (options?.model) {
    modelContexts.set(options.model.id, options.model);
  }

  for (const model of options?.models ?? []) {
    modelContexts.set(model.id, model);
  }

  if (options?.models || options?.model) {
    for (const node of workflow.nodes) {
      if (!hasModelId(node)) {
        continue;
      }

      const model = modelContexts.get(node.data.modelId);

      if (!model) {
        issues.push(`Node ${node.id} references unavailable model ${node.data.modelId}.`);
        continue;
      }

      if (!modelSupportsNode(model, node)) {
        issues.push(`Model ${model.name} cannot run node ${node.id} (${node.type}).`);
      }

      if (!routeSupportsExecutionEnvironment(model.route, workflow.executionEnvironment)) {
        issues.push(
          `Model ${model.name} route ${model.route ?? "unresolved"} is not compatible with workflow execution environment ${workflow.executionEnvironment}.`
        );
      }

      if ("route" in node.data && node.data.route && model.route && node.data.route !== model.route) {
        issues.push(`Node ${node.id} route ${node.data.route} does not match authorised model route ${model.route}.`);
      }

      const controls = imageNodePixels(node);
      if (controls) {
        if (controls.pixels > model.maxPixels) {
          issues.push(`Image node ${node.id} exceeds ${model.name} pixel limit.`);
        }

        if (model.maxSteps && (controls.steps ?? 1) > model.maxSteps) {
          issues.push(`Image node ${node.id} exceeds ${model.name} step limit.`);
        }
      }
    }
  }

  if (issues.length > 0) {
    return { ok: false, issues };
  }

  return { ok: true, workflow, warnings };
}

export function getWorkflowModelIds(workflow: WorkflowDocument) {
  return Array.from(new Set(workflow.nodes.filter(hasModelId).map((node) => node.data.modelId))).filter(
    (modelId): modelId is string => typeof modelId === "string"
  );
}

export function getWorkflowAssetIds(workflow: WorkflowDocument) {
  return Array.from(
    new Set(
      workflow.nodes
        .filter((node): node is Extract<WorkflowNode, { type: "starting-image" }> => node.type === "starting-image")
        .map((node) => node.data.assetId)
    )
  ).filter((assetId): assetId is string => typeof assetId === "string");
}

export function estimateGenerationCredits(
  workflow: WorkflowDocument,
  models?: ValidationModelContext | ValidationModelContext[]
) {
  const modelMap = new Map<string, ValidationModelContext>();
  const modelList = Array.isArray(models) ? models : models ? [models] : [];

  for (const model of modelList) {
    modelMap.set(model.id, model);
  }

  let credits = 0;

  for (const node of workflow.nodes) {
    if (!hasModelId(node)) {
      continue;
    }

    const model = modelMap.get(node.data.modelId);
    const base = model?.baseCreditCost ?? 4;

    if (node.type === "text-to-image" || node.type === "image-to-image") {
      const pixels = node.data.width * node.data.height;
      const resolutionFactor = pixels / (768 * 768);
      const stepFactor = node.data.steps === undefined ? 1 : node.data.steps / 30;
      credits += Math.max(1, Math.ceil(base * resolutionFactor * stepFactor * node.data.batch));
      continue;
    }

    if (node.type === "image-transform") {
      credits += node.data.modelId ? Math.max(1, Math.ceil(base * 0.5)) : 1;
      continue;
    }

    credits += Math.max(1, Math.ceil(base * 0.25));
  }

  return Math.max(1, credits);
}
