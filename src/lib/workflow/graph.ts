import { getModelById } from "../models/catalog";
import {
  approvedNodeTypes,
  nodePorts,
  workflowLimits,
  type ApprovedNodeType,
  type PortType,
  type WorkflowDocument,
  type WorkflowEdge,
  type WorkflowNode
} from "./schema";
import { getWorkflowNodeDefinition } from "./registry";

export type WorkflowGraphResult<T> =
  | {
      ok: true;
      value: T;
      notices: string[];
    }
  | {
      ok: false;
      issues: string[];
    };

export type AddWorkflowNodeResult = {
  workflow: WorkflowDocument;
  node: WorkflowNode;
  selectedNodeId: string;
};

export type RemoveWorkflowNodeResult = {
  workflow: WorkflowDocument;
  removedNode: WorkflowNode;
  removedEdgeIds: string[];
  selectedNodeId: string | null;
};

export type AddWorkflowEdgeInput = Pick<WorkflowEdge, "source" | "sourceHandle" | "target" | "targetHandle"> & {
  id?: string;
};

export type AddWorkflowEdgeResult = {
  workflow: WorkflowDocument;
  edge: WorkflowEdge;
};

const maxIdAttempts = workflowLimits.maxNodes + workflowLimits.maxEdges + 200;
const nodeGrid = {
  x: 80,
  y: 60,
  width: 280,
  height: 560,
  columns: 5
} as const;

export function cloneWorkflowDocument(workflow: WorkflowDocument): WorkflowDocument {
  return JSON.parse(JSON.stringify(workflow)) as WorkflowDocument;
}

export function isApprovedWorkflowNodeType(type: string): type is ApprovedNodeType {
  return approvedNodeTypes.includes(type as ApprovedNodeType);
}

function sanitizeIdentifierBase(value: string) {
  const safe = value.replace(/[^a-zA-Z0-9_-]+/g, "_").replace(/-+/g, "_").replace(/^_+|_+$/g, "");
  return (safe || "node").slice(0, 64);
}

export function createUniqueWorkflowNodeId(
  type: ApprovedNodeType,
  workflow: WorkflowDocument,
  options?: {
    baseId?: string;
    reservedIds?: Iterable<string>;
  }
) {
  const base = sanitizeIdentifierBase(options?.baseId ?? type.replaceAll("-", "_"));
  const existing = new Set(workflow.nodes.map((node) => node.id));

  for (const reservedId of options?.reservedIds ?? []) {
    existing.add(reservedId);
  }

  if (!existing.has(base)) {
    return base;
  }

  for (let index = 2; index < maxIdAttempts; index += 1) {
    const candidate = `${base}_${index}`;
    if (candidate.length <= 80 && !existing.has(candidate)) {
      return candidate;
    }
  }

  return null;
}

function positionsOverlap(left: WorkflowNode["position"], right: WorkflowNode["position"]) {
  // Leave room for the labeled input/output rows on the tallest node cards.
  return Math.abs(left.x - right.x) < 252 && Math.abs(left.y - right.y) < 540;
}

export function nextWorkflowNodePosition(workflow: WorkflowDocument) {
  const startIndex = Math.max(0, workflow.nodes.length - 1);

  for (let offset = 0; offset < workflowLimits.maxNodes * 2; offset += 1) {
    const index = startIndex + offset;
    const position = {
      x: nodeGrid.x + (index % nodeGrid.columns) * nodeGrid.width,
      y: nodeGrid.y + Math.floor(index / nodeGrid.columns) * nodeGrid.height
    };

    if (!workflow.nodes.some((node) => positionsOverlap(position, node.position))) {
      return position;
    }
  }

  return {
    x: nodeGrid.x,
    y: nodeGrid.y + Math.ceil(workflow.nodes.length / nodeGrid.columns) * nodeGrid.height
  };
}

function deterministicSeed(input: string) {
  let hash = 2166136261;

  for (let index = 0; index < input.length; index += 1) {
    hash ^= input.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }

  return hash >>> 0;
}

export function createDefaultWorkflowNode(
  type: ApprovedNodeType,
  workflow: WorkflowDocument,
  options?: {
    id?: string;
    position?: WorkflowNode["position"];
  }
): WorkflowGraphResult<WorkflowNode> {
  if (!isApprovedWorkflowNodeType(type)) {
    return { ok: false, issues: [`Unsupported workflow node type: ${type}`] };
  }

  const id = options?.id ?? createUniqueWorkflowNodeId(type, workflow);

  if (!id) {
    return { ok: false, issues: [`Could not create a unique node id for ${type}.`] };
  }

  if (workflow.nodes.some((node) => node.id === id)) {
    return { ok: false, issues: [`Node id ${id} already exists.`] };
  }

  const position = options?.position ?? nextWorkflowNodePosition(workflow);
  const node = getWorkflowNodeDefinition(type).createDefaultNode({
    id,
    position,
    selectedModel: workflow.selectedModel,
    seed: deterministicSeed(`${workflow.schemaVersion}:${workflow.selectedModel}:${type}:${id}:${workflow.nodes.length}`)
  });
  const definition = getModelById(workflow.selectedModel);
  if (definition && (node.type === "text-to-image" || node.type === "image-to-image")) {
    const data = { ...node.data, ...definition.defaults, modelId: definition.id, route: definition.route } as Record<string, unknown>;
    for (const field of definition.unsupportedParameters) delete data[field];
    if (node.type === "text-to-image") delete data.strength;
    return { ok: true, value: { ...node, data } as WorkflowNode, notices: [] };
  }

  return { ok: true, value: node, notices: [] };
}

export function addWorkflowNode(
  workflow: WorkflowDocument,
  type: ApprovedNodeType,
  options?: {
    id?: string;
    position?: WorkflowNode["position"];
  }
): WorkflowGraphResult<AddWorkflowNodeResult> {
  if (workflow.nodes.length >= workflowLimits.maxNodes) {
    return {
      ok: false,
      issues: [`Workflow has reached the maximum of ${workflowLimits.maxNodes} nodes.`]
    };
  }

  const nodeResult = createDefaultWorkflowNode(type, workflow, options);

  if (!nodeResult.ok) {
    return nodeResult;
  }

  const workflowWithNode: WorkflowDocument = {
    ...workflow,
    nodes: [...workflow.nodes, nodeResult.value],
    edges: [...workflow.edges]
  };

  return {
    ok: true,
    value: {
      workflow: workflowWithNode,
      node: nodeResult.value,
      selectedNodeId: nodeResult.value.id
    },
    notices: [`${getWorkflowNodeDefinition(type).label} added. Connect it before generation.`]
  };
}

export function removeWorkflowNode(
  workflow: WorkflowDocument,
  nodeId: string,
  options?: {
    selectedNodeId?: string | null;
  }
): WorkflowGraphResult<RemoveWorkflowNodeResult> {
  const removedNode = workflow.nodes.find((node) => node.id === nodeId);

  if (!removedNode) {
    return { ok: false, issues: [`Node ${nodeId} was not found.`] };
  }

  const nodes = workflow.nodes.filter((node) => node.id !== nodeId);
  const removedEdgeIds: string[] = [];
  const edges = workflow.edges.filter((edge) => {
    const incident = edge.source === nodeId || edge.target === nodeId;

    if (incident) {
      removedEdgeIds.push(edge.id);
    }

    return !incident;
  });
  const requestedSelection = options?.selectedNodeId;
  const selectedNodeId =
    requestedSelection && requestedSelection !== nodeId && nodes.some((node) => node.id === requestedSelection)
      ? requestedSelection
      : (nodes[0]?.id ?? null);

  return {
    ok: true,
    value: {
      workflow: {
        ...workflow,
        nodes,
        edges
      },
      removedNode,
      removedEdgeIds,
      selectedNodeId
    },
    notices: [
      removedEdgeIds.length > 0
        ? `${getWorkflowNodeDefinition(removedNode.type).label} removed with ${removedEdgeIds.length} connection(s).`
        : `${getWorkflowNodeDefinition(removedNode.type).label} removed.`
    ]
  };
}

export function removeDanglingWorkflowEdges(
  workflow: WorkflowDocument
): WorkflowGraphResult<{ workflow: WorkflowDocument; removedEdgeIds: string[] }> {
  const nodeIds = new Set(workflow.nodes.map((node) => node.id));
  const removedEdgeIds: string[] = [];
  const edges = workflow.edges.filter((edge) => {
    const dangling = !nodeIds.has(edge.source) || !nodeIds.has(edge.target);

    if (dangling) {
      removedEdgeIds.push(edge.id);
    }

    return !dangling;
  });

  return {
    ok: true,
    value: {
      workflow: {
        ...workflow,
        edges
      },
      removedEdgeIds
    },
    notices:
      removedEdgeIds.length > 0
        ? [`Removed ${removedEdgeIds.length} dangling connection(s).`]
        : ["No dangling connections found."]
  };
}

function uniqueWorkflowEdgeId(workflow: WorkflowDocument, edge: AddWorkflowEdgeInput) {
  const base = sanitizeIdentifierBase(`e_${edge.source}_${edge.sourceHandle}_${edge.target}_${edge.targetHandle}`).slice(0, 96);
  const existing = new Set(workflow.edges.map((candidate) => candidate.id));

  if (edge.id && !existing.has(edge.id)) {
    return edge.id;
  }

  if (!existing.has(base)) {
    return base;
  }

  for (let index = 2; index < maxIdAttempts; index += 1) {
    const candidate = `${base}_${index}`.slice(0, 120);
    if (!existing.has(candidate)) {
      return candidate;
    }
  }

  return null;
}

function portForHandle(
  node: WorkflowNode,
  direction: "inputs" | "outputs",
  handle: string
): PortType | undefined {
  return nodePorts[node.type][direction][handle];
}

function createsCycle(workflow: WorkflowDocument, edge: AddWorkflowEdgeInput) {
  const adjacency = new Map<string, string[]>();

  for (const node of workflow.nodes) {
    adjacency.set(node.id, []);
  }

  for (const existing of workflow.edges) {
    adjacency.get(existing.source)?.push(existing.target);
  }

  adjacency.get(edge.source)?.push(edge.target);

  const stack = [edge.target];
  const visited = new Set<string>();

  while (stack.length > 0) {
    const nodeId = stack.pop()!;

    if (nodeId === edge.source) {
      return true;
    }

    if (visited.has(nodeId)) {
      continue;
    }

    visited.add(nodeId);
    stack.push(...(adjacency.get(nodeId) ?? []));
  }

  return false;
}

export function addWorkflowEdge(
  workflow: WorkflowDocument,
  edgeInput: AddWorkflowEdgeInput
): WorkflowGraphResult<AddWorkflowEdgeResult> {
  if (workflow.edges.length >= workflowLimits.maxEdges) {
    return { ok: false, issues: [`Workflow has reached the maximum of ${workflowLimits.maxEdges} connections.`] };
  }

  if (edgeInput.source === edgeInput.target) {
    return { ok: false, issues: ["A node cannot connect to itself."] };
  }

  const source = workflow.nodes.find((node) => node.id === edgeInput.source);
  const target = workflow.nodes.find((node) => node.id === edgeInput.target);

  if (!source || !target) {
    return { ok: false, issues: ["Connection references a missing node."] };
  }

  const sourceType = portForHandle(source, "outputs", edgeInput.sourceHandle);
  const targetType = portForHandle(target, "inputs", edgeInput.targetHandle);

  if (!sourceType) {
    return { ok: false, issues: [`${source.id}.${edgeInput.sourceHandle} is not a valid output port.`] };
  }

  if (!targetType) {
    return { ok: false, issues: [`${target.id}.${edgeInput.targetHandle} is not a valid input port.`] };
  }

  if (sourceType !== targetType) {
    return { ok: false, issues: [`Cannot connect ${sourceType} output to ${targetType} input.`] };
  }

  if (workflow.edges.some((edge) => edge.target === edgeInput.target && edge.targetHandle === edgeInput.targetHandle)) {
    return { ok: false, issues: [`${target.id}.${edgeInput.targetHandle} already has a connection.`] };
  }

  const fanOut = workflow.edges.filter((edge) => edge.source === edgeInput.source && edge.sourceHandle === edgeInput.sourceHandle).length;

  if (fanOut >= workflowLimits.maxFanOut) {
    return { ok: false, issues: [`${source.id}.${edgeInput.sourceHandle} has reached maximum fan-out.`] };
  }

  if (
    workflow.edges.some(
      (edge) =>
        edge.source === edgeInput.source &&
        edge.sourceHandle === edgeInput.sourceHandle &&
        edge.target === edgeInput.target &&
        edge.targetHandle === edgeInput.targetHandle
    )
  ) {
    return { ok: false, issues: ["This connection already exists."] };
  }

  if (createsCycle(workflow, edgeInput)) {
    return { ok: false, issues: ["This connection would create a cycle."] };
  }

  const id = uniqueWorkflowEdgeId(workflow, edgeInput);

  if (!id) {
    return { ok: false, issues: ["Could not create a unique connection id."] };
  }

  const edge: WorkflowEdge = {
    id,
    source: edgeInput.source,
    sourceHandle: edgeInput.sourceHandle,
    target: edgeInput.target,
    targetHandle: edgeInput.targetHandle
  };

  return {
    ok: true,
    value: {
      workflow: {
        ...workflow,
        edges: [...workflow.edges, edge]
      },
      edge
    },
    notices: ["Connection added. Run Validate before generation."]
  };
}

export function updateWorkflowNodePosition(
  workflow: WorkflowDocument,
  nodeId: string,
  position: WorkflowNode["position"]
): WorkflowDocument {
  return {
    ...workflow,
    nodes: workflow.nodes.map((node) => (node.id === nodeId ? { ...node, position } : node))
  };
}
