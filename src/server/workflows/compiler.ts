import "server-only";

import crypto from "node:crypto";
import { assertWorkflowAssetsOwned, getOwnedWorkflowAssetReferences } from "@/server/assets/assets";
import { mongoCollection } from "@/server/db/mongodb";
import {
  collectionNames,
  type ExecutionPlanDocument,
  type ExecutionPlanStep,
  type GenerationStepDocument,
  type WorkflowRevisionDocument
} from "@/server/db/types";
import { validationFailed } from "@/server/errors";
import {
  estimateGenerationCredits,
  executableNodeTypes,
  getWorkflowAssetIds,
  getWorkflowModelIds,
  nodePorts,
  validateWorkflow,
  workflowSchemaVersion,
  type ProviderRoute,
  type ValidationModelContext,
  type WorkflowDocument,
  type WorkflowEdge,
  type WorkflowNode
} from "@/lib/workflow/schema";
import { requireEnabledModels, type EnabledModelRecord } from "@/server/models/models";

export const executionPlanVersion = 1;
export const workflowCompilerVersion = "workflow-dag-compiler-v1";

export type OwnedAssetReference = {
  assetId: string;
  kind: string;
  bucket: string;
  objectPath: string;
  contentType: string;
  width?: number;
  height?: number;
  sizeBytes?: number;
  sha256?: string;
};

type CompileWorkflowExecutionPlanInput = {
  ownerId: string;
  workflowId: string;
  workflowRevisionId: string;
  workflow: WorkflowDocument;
  models: EnabledModelRecord[];
  assetReferences?: OwnedAssetReference[];
};

type CanonicalExecutionPlan = Omit<ExecutionPlanDocument, "_id" | "createdAt" | "planHash">;

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value);
  }

  if (Array.isArray(value)) {
    return `[${value.map((entry) => stableStringify(entry)).join(",")}]`;
  }

  const entries = Object.entries(value)
    .filter(([, entry]) => typeof entry !== "undefined")
    .sort(([left], [right]) => left.localeCompare(right));

  return `{${entries.map(([key, entry]) => `${JSON.stringify(key)}:${stableStringify(entry)}`).join(",")}}`;
}

function hashPlan(plan: CanonicalExecutionPlan) {
  return crypto.createHash("sha256").update(stableStringify(plan)).digest("hex");
}

function ownerStoragePrefix(ownerId: string) {
  return crypto.createHash("sha256").update(ownerId).digest("hex").slice(0, 20);
}

function isExecutableNode(node: WorkflowNode): node is Extract<WorkflowNode, { type: (typeof executableNodeTypes)[number] }> {
  return executableNodeTypes.includes(node.type as (typeof executableNodeTypes)[number]);
}

function stepIdForNode(nodeId: string) {
  return `step_${nodeId}`;
}

function topologicalNodes(workflow: WorkflowDocument) {
  const inDegree = new Map<string, number>();
  const outgoing = new Map<string, WorkflowEdge[]>();
  const nodeById = new Map(workflow.nodes.map((node) => [node.id, node]));

  for (const node of workflow.nodes) {
    inDegree.set(node.id, 0);
    outgoing.set(node.id, []);
  }

  for (const edge of workflow.edges) {
    inDegree.set(edge.target, (inDegree.get(edge.target) ?? 0) + 1);
    outgoing.get(edge.source)?.push(edge);
  }

  const queued = workflow.nodes.filter((node) => (inDegree.get(node.id) ?? 0) === 0);
  const ordered: WorkflowNode[] = [];

  while (queued.length > 0) {
    const node = queued.shift()!;
    ordered.push(node);

    for (const edge of outgoing.get(node.id) ?? []) {
      const nextDegree = (inDegree.get(edge.target) ?? 0) - 1;
      inDegree.set(edge.target, nextDegree);

      if (nextDegree === 0) {
        const target = nodeById.get(edge.target);
        if (target) {
          queued.push(target);
        }
      }
    }
  }

  if (ordered.length !== workflow.nodes.length) {
    throw validationFailed("Workflow contains a cycle.");
  }

  return ordered;
}

function executionPolicyForNode(node: WorkflowNode) {
  return {
    timeoutSeconds: node.execution?.timeoutSeconds ?? 300,
    retryPolicy: {
      maxAttempts: node.execution?.retryPolicy.maxAttempts ?? 1,
      backoffSeconds: node.execution?.retryPolicy.backoffSeconds ?? 10,
      retryable: node.execution?.retryPolicy.retryable ?? true
    },
    optional: node.execution?.optional ?? false
  };
}

function adapterIdForNode(node: WorkflowNode, route?: ProviderRoute) {
  if (node.type === "safety-check") {
    return "safety-moderation";
  }

  if (node.type === "output") {
    return "output-router";
  }

  if (node.type === "image-transform" && !node.data.modelId) {
    return "image-transform";
  }

  return route ?? "development-fake";
}

function outputPortsForNode(node: WorkflowNode) {
  return Object.fromEntries(
    Object.entries(nodePorts[node.type].outputs).map(([handle, type]) => [
      handle,
      {
        type,
        ...(type === "image"
          ? { artifactRole: (node.type === "output" ? "final" : "intermediate") as "intermediate" | "final" }
          : {})
      }
    ])
  );
}

function constantOutputForNode(node: WorkflowNode, assetReferences: Map<string, OwnedAssetReference>) {
  if (node.type === "prompt-input") {
    return node.data.prompt;
  }

  if (node.type === "negative-prompt") {
    return node.data.prompt;
  }

  if (node.type === "dimensions") {
    return {
      width: node.data.width,
      height: node.data.height,
      batch: node.data.batch
    };
  }

  if (node.type === "seed") {
    return {
      seed: node.data.seed,
      locked: node.data.locked
    };
  }

  if (node.type === "starting-image") {
    const asset = assetReferences.get(node.data.assetId);

    if (!asset) {
      throw validationFailed("Starting image assets must be completed uploads owned by this account.", {
        missingAssetIds: [node.data.assetId]
      });
    }

    return {
      ...asset,
      strength: node.data.strength
    };
  }

  return undefined;
}

function imageEstimates(node: WorkflowNode) {
  if (node.type !== "text-to-image" && node.type !== "image-to-image") {
    return {};
  }

  return {
    pixels: node.data.width * node.data.height,
    steps: node.data.steps,
    batch: node.data.batch
  };
}

function stepEstimate(node: WorkflowNode, model?: ValidationModelContext) {
  if (!model && (node.type === "safety-check" || node.type === "output")) {
    const policy = executionPolicyForNode(node);

    return {
      credits: 0,
      timeoutSeconds: policy.timeoutSeconds
    };
  }

  const creditEstimate = estimateGenerationCredits(
    {
      schemaVersion: workflowSchemaVersion,
      selectedModel: model?.id ?? "model-unresolved",
      executionEnvironment: "gcp-hosted",
      nodes: [node],
      edges: []
    },
    model
  );
  const policy = executionPolicyForNode(node);

  return {
    credits: creditEstimate,
    timeoutSeconds: policy.timeoutSeconds,
    ...imageEstimates(node)
  };
}

function parametersForNode(node: WorkflowNode) {
  if (node.type === "output") {
    return {
      format: node.data.format,
      privateByDefault: true,
      includeMetadata: node.data.includeMetadata
    };
  }

  return {
    ...node.data,
    ...(node.type === "safety-check" ? {} : { route: "route" in node.data ? node.data.route : undefined })
  };
}

export function compileWorkflowExecutionPlan(input: CompileWorkflowExecutionPlanInput): ExecutionPlanDocument {
  const modelsById = new Map(input.models.map((model) => [model.id, model]));
  const assetReferences = new Map((input.assetReferences ?? []).map((asset) => [asset.assetId, asset]));
  const validation = validateWorkflow(input.workflow, {
    models: input.models.map((model) => ({
      id: model.id,
      name: model.displayName,
      route: model.route,
      maxPixels: model.maxPixels,
      maxSteps: model.maxSteps,
      baseCreditCost: model.baseCreditCost,
      isEnabled: model.isEnabled,
      capabilities: model.capabilities
    }))
  });

  if (!validation.ok) {
    throw validationFailed("Workflow validation failed.", { issues: validation.issues });
  }

  const workflow = validation.workflow;
  const nodeById = new Map(workflow.nodes.map((node) => [node.id, node]));
  const sourceStepByNodeId = new Map<string, string>();

  for (const node of workflow.nodes) {
    if (isExecutableNode(node)) {
      sourceStepByNodeId.set(node.id, stepIdForNode(node.id));
    }
  }

  const steps: ExecutionPlanStep[] = [];

  for (const node of topologicalNodes(workflow)) {
    if (!isExecutableNode(node)) {
      continue;
    }

    const model = "modelId" in node.data && typeof node.data.modelId === "string" ? modelsById.get(node.data.modelId) : undefined;
    const validationModel = model
      ? {
          id: model.id,
          name: model.displayName,
          route: model.route,
          maxPixels: model.maxPixels,
          maxSteps: model.maxSteps,
          baseCreditCost: model.baseCreditCost,
          isEnabled: model.isEnabled,
          capabilities: model.capabilities
        }
      : undefined;
    const policy = executionPolicyForNode(node);
    const inputPorts: ExecutionPlanStep["inputPorts"] = {};
    const dependencies = new Set<string>();

    for (const edge of workflow.edges.filter((candidate) => candidate.target === node.id)) {
      const source = nodeById.get(edge.source);

      if (!source) {
        continue;
      }

      const sourceStepId = sourceStepByNodeId.get(source.id);
      const portType = nodePorts[node.type].inputs[edge.targetHandle];

      if (sourceStepId) {
        dependencies.add(sourceStepId);
        inputPorts[edge.targetHandle] = {
          sourceStepId,
          sourceNodeId: source.id,
          sourcePort: edge.sourceHandle,
          type: portType
        };
      } else {
        inputPorts[edge.targetHandle] = {
          sourceNodeId: source.id,
          sourcePort: edge.sourceHandle,
          type: portType,
          value: constantOutputForNode(source, assetReferences)
        };
      }
    }

    steps.push({
      id: stepIdForNode(node.id),
      nodeId: node.id,
      nodeType: node.type,
      adapterId: adapterIdForNode(node, model?.route),
      ...(model
        ? {
            modelId: model.id,
            providerId: model.provider.id,
            route: model.route,
            pinnedModelVersion: model.pinnedVersion ?? model.id
          }
        : {}),
      inputPorts,
      outputPorts: outputPortsForNode(node),
      parameters: parametersForNode(node),
      dependencies: Array.from(dependencies).sort(),
      retryPolicy: policy.retryPolicy,
      timeoutSeconds: policy.timeoutSeconds,
      optional: policy.optional,
      estimates: stepEstimate(node, validationModel),
      outputObjectPrefix: `outputs/${ownerStoragePrefix(input.ownerId)}/${input.workflowRevisionId}/${stepIdForNode(node.id)}`
    });
  }

  const canonicalPlan: CanonicalExecutionPlan = {
    ownerId: input.ownerId,
    workflowId: input.workflowId,
    workflowRevisionId: input.workflowRevisionId,
    version: executionPlanVersion,
    workflowSchemaVersion,
    compilerVersion: workflowCompilerVersion,
    executionEnvironment: workflow.executionEnvironment,
    steps,
    routeSummary: Array.from(new Set(steps.map((step) => step.route ?? step.adapterId))).sort(),
    modelIds: getWorkflowModelIds(workflow).sort(),
    assetIds: getWorkflowAssetIds(workflow).sort(),
    estimates: {
      credits: steps.reduce((sum, step) => sum + step.estimates.credits, 0),
      timeoutSeconds: steps.reduce((sum, step) => sum + step.estimates.timeoutSeconds, 0),
      maxPixels: steps.reduce((max, step) => Math.max(max, step.estimates.pixels ?? 0), 0)
    }
  };
  const planHash = hashPlan(canonicalPlan);

  return {
    _id: `plan_${planHash.slice(0, 32)}`,
    planHash,
    ...canonicalPlan,
    createdAt: new Date(0)
  };
}

export function createInitialGenerationSteps(input: {
  plan: ExecutionPlanDocument;
  jobId: string;
  attemptId: string;
}): GenerationStepDocument[] {
  return input.plan.steps.map((step) => ({
    id: step.id,
    nodeId: step.nodeId,
    nodeType: step.nodeType,
    status: step.dependencies.length === 0 ? "READY" : "PENDING",
    progress: 0,
    adapterId: step.adapterId,
    modelId: step.modelId,
    providerId: step.providerId,
    route: step.route,
    attemptNumber: 0,
    idempotencyKey: `generation:${input.jobId}:attempt:${input.attemptId}:step:${step.id}`,
    attempts: []
  }));
}

export async function compileAndPersistExecutionPlan(input: {
  ownerId: string;
  workflowRevision: WorkflowRevisionDocument;
}) {
  await assertWorkflowAssetsOwned(input.ownerId, input.workflowRevision.workflow);
  const models = await requireEnabledModels(getWorkflowModelIds(input.workflowRevision.workflow));
  const assetReferences = await getOwnedWorkflowAssetReferences(input.ownerId, input.workflowRevision.workflow);
  const compiled = compileWorkflowExecutionPlan({
    ownerId: input.ownerId,
    workflowId: input.workflowRevision.workflowId,
    workflowRevisionId: input.workflowRevision._id,
    workflow: input.workflowRevision.workflow,
    models,
    assetReferences
  });
  const plans = await mongoCollection<ExecutionPlanDocument>(collectionNames.executionPlans);
  const document: ExecutionPlanDocument = {
    ...compiled,
    createdAt: new Date()
  };

  await plans.updateOne(
    {
      workflowRevisionId: document.workflowRevisionId,
      planHash: document.planHash
    },
    {
      $setOnInsert: document
    },
    { upsert: true }
  );

  return (
    (await plans.findOne({
      workflowRevisionId: document.workflowRevisionId,
      planHash: document.planHash
    })) ?? document
  );
}
