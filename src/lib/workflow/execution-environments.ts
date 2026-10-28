import type {
  ProviderRoute,
  ValidationModelContext,
  WorkflowDocument,
  WorkflowExecutionEnvironment,
  WorkflowNode
} from "./schema";

export type ExecutionEnvironmentDefinition = {
  id: WorkflowExecutionEnvironment;
  label: string;
  description: string;
  routes: readonly ProviderRoute[];
  availability: "available" | "requires-configuration" | "development-only";
};

export type ExecutionEnvironmentModelContext = ValidationModelContext & {
  availability?: "available" | "requires-credentials" | "development-only" | "not-configured" | "unavailable";
};

export const executionEnvironmentDefinitions = [
  {
    id: "huggingface-l4",
    label: "Hugging Face on GCP L4",
    description: "Private NVIDIA L4 with Z-Image Turbo or FLUX.2 Klein 4B, loaded from the GCP model cache; scales to zero.",
    routes: ["huggingface-image"],
    availability: "requires-configuration"
  },
  {
    id: "gcp-hosted",
    label: "GCP hosted worker",
    description: "Private NVIDIA L4 with Ollama and the fixed FLUX.2 Klein 4B FP8 model; scales to zero.",
    routes: ["gcp-hosted-gpu"],
    availability: "requires-configuration"
  },
  {
    id: "google-ai-studio",
    label: "Google AI Studio",
    description: "Google AI Studio image adapter using the configured server-side API key.",
    routes: ["google-ai-studio-image"],
    availability: "requires-configuration"
  },
  {
    id: "external-byok",
    label: "External BYOK",
    description: "Unavailable: no specifically implemented external BYOK integration.",
    routes: ["external-byok"],
    availability: "requires-configuration"
  },
  {
    id: "development-local",
    label: "Local development",
    description: "Explicit non-production fake worker path for lifecycle testing.",
    routes: ["development-fake"],
    availability: "development-only"
  }
] as const satisfies readonly ExecutionEnvironmentDefinition[];

export function getExecutionEnvironmentDefinition(environment: WorkflowExecutionEnvironment) {
  return executionEnvironmentDefinitions.find((definition) => definition.id === environment) ?? executionEnvironmentDefinitions.find((definition) => definition.id === "gcp-hosted")!;
}

export function executionEnvironmentRoutes(environment: WorkflowExecutionEnvironment): readonly ProviderRoute[] {
  return getExecutionEnvironmentDefinition(environment).routes;
}

export function routeMatchesExecutionEnvironment(route: string | undefined, environment: WorkflowExecutionEnvironment) {
  return Boolean(route && executionEnvironmentRoutes(environment).includes(route as ProviderRoute));
}

function capabilityList(capabilities: unknown) {
  return Array.isArray(capabilities) ? capabilities.filter((capability): capability is string => typeof capability === "string") : [];
}

export function workflowNodeRequiresModel(node: WorkflowNode): node is WorkflowNode & { data: WorkflowNode["data"] & { modelId: string } } {
  return "modelId" in node.data && typeof node.data.modelId === "string" && node.data.modelId.length > 0;
}

export function modelSupportsWorkflowNode(model: ExecutionEnvironmentModelContext, node: WorkflowNode) {
  const capabilities = capabilityList(model.capabilities);

  if (model.isEnabled === false) {
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

export function isModelCompatibleWithExecutionEnvironment(
  model: ExecutionEnvironmentModelContext,
  environment: WorkflowExecutionEnvironment,
  node?: WorkflowNode
) {
  return routeMatchesExecutionEnvironment(model.route, environment) && (!node || modelSupportsWorkflowNode(model, node));
}

export function listCompatibleEnabledModels(
  models: ExecutionEnvironmentModelContext[],
  environment: WorkflowExecutionEnvironment,
  node?: WorkflowNode
) {
  return models.filter((model) => model.isEnabled !== false && isModelCompatibleWithExecutionEnvironment(model, environment, node));
}

export function getWorkflowEnvironmentCompatibility(workflow: WorkflowDocument, models: ExecutionEnvironmentModelContext[]) {
  const modelsById = new Map(models.map((model) => [model.id, model]));
  const issues: string[] = [];

  for (const node of workflow.nodes) {
    if (!workflowNodeRequiresModel(node)) {
      continue;
    }

    const model = modelsById.get(node.data.modelId);

    if (!model) {
      issues.push(`Node ${node.id} references unavailable model ${node.data.modelId}.`);
      continue;
    }

    if (!isModelCompatibleWithExecutionEnvironment(model, workflow.executionEnvironment, node)) {
      issues.push(`Node ${node.id} model ${model.name} is not compatible with ${workflow.executionEnvironment}.`);
    }
  }

  return {
    ok: issues.length === 0,
    issues
  };
}

export function getExecutionEnvironmentSetupReasons(input: {
  environment: WorkflowExecutionEnvironment;
  models: ExecutionEnvironmentModelContext[];
  hasCredential?: boolean;
  allowDevelopmentLocal?: boolean;
}) {
  const reasons: string[] = [];
  const compatibleModels = listCompatibleEnabledModels(input.models, input.environment);

  if (input.environment === "development-local" && input.allowDevelopmentLocal === false) {
    reasons.push("Local development execution is disabled in production.");
  }

  if (compatibleModels.length === 0) {
    reasons.push(`No enabled model is registered for ${getExecutionEnvironmentDefinition(input.environment).label}.`);
  }

  if (compatibleModels.some((model) => model.availability === "not-configured")) {
    reasons.push("The selected environment has models that still need runtime configuration.");
  }

  if (compatibleModels.some((model) => model.availability === "requires-credentials") && input.hasCredential === false) {
    reasons.push("A provider credential or server-side API key is required before generation.");
  }

  return reasons;
}
