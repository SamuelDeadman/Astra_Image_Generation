"use client";

import {
  Background,
  Controls,
  Handle,
  MarkerType,
  MiniMap,
  Position,
  ReactFlow,
  type Connection,
  type Edge,
  type EdgeChange,
  type Node,
  type ReactFlowInstance,
  type NodeChange,
  type NodeProps
} from "@xyflow/react";
import {
  Ban,
  BrainCircuit,
  Captions,
  Download,
  FileImage,
  Image as ImageIcon,
  MessageSquareText,
  Paintbrush,
  Plus,
  Ruler,
  Save,
  ShieldCheck,
  SlidersHorizontal,
  Sparkles,
  Trash2,
  Upload
} from "lucide-react";
import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import {
  estimateGenerationCredits,
  validateWorkflow,
  type ApprovedNodeType,
  type PortType,
  type ProviderRoute,
  type WorkflowDocument,
  type WorkflowNode
} from "@/lib/workflow/schema";
import {
  addWorkflowEdge,
  addWorkflowNode,
  cloneWorkflowDocument,
  removeWorkflowNode
} from "@/lib/workflow/graph";
import {
  createWorkflowExportPayload,
  maxWorkflowImportBytes,
  parseWorkflowJsonText,
  sanitizeWorkflowFilename,
  stringifyWorkflowDocument
} from "@/lib/workflow/serialization";
import { getWorkflowNodeDefinition, workflowNodeDefinitions, type WorkflowIconKey } from "@/lib/workflow/registry";
import { baseTextToImageWorkflow } from "@/lib/workflow/templates";
import { announceStudioDataChanged } from "@/components/studio/events";
import { apiErrorMessage, fetchWithTimeout } from "@/lib/http/client";
import { getModelById } from "@/lib/models/catalog";
import { previewModelDefaults, applyConfirmedModelDefaults, workflowModelConstraintIssues, type DefaultsPreview } from "@/lib/models/constraints";
import { ModelDefaultsConfirmation } from "@/components/studio/ModelDefaultsConfirmation";
import { commitCanvasPositions, reconcileCanvasNodes, type StudioFlowNode, type StudioNodeData } from "./workflow-canvas-state";

type ModelOption = {
  id: string;
  name: string;
  maxPixels: number;
  maxSteps: number;
  baseCreditCost: number;
  route?: ProviderRoute | string;
  provider?: string;
  family?: string;
  capabilities?: unknown;
  isEnabled: boolean;
};

type WorkflowSummaryDTO = {
  id: string;
  name: string;
  status: string;
  revision: number;
  updatedAt: string;
};

type WorkflowDetailDTO = WorkflowSummaryDTO & {
  currentVersion?: {
    id: string;
    versionNumber: number;
    graph: WorkflowDocument;
    selectedModel: string;
    createdAt: string;
  };
};

type CatalogueSelection = {
  type: ApprovedNodeType;
  nonce: number;
} | null;

type ModelEditableNode = Extract<
  WorkflowNode,
  { type: "llm-prompt" | "text-to-image" | "image-to-image" | "image-analysis" | "image-transform" }
>;
type LlmOutputMode = Extract<WorkflowNode, { type: "llm-prompt" }>["data"]["outputMode"];
type ImageAnalysisOutputMode = Extract<WorkflowNode, { type: "image-analysis" }>["data"]["outputMode"];
type ImageSampler = Extract<WorkflowNode, { type: "text-to-image" }>["data"]["sampler"];
type ImageScheduler = Extract<WorkflowNode, { type: "text-to-image" }>["data"]["scheduler"];
type ImageOutputFormat = Extract<WorkflowNode, { type: "text-to-image" }>["data"]["outputFormat"];
type ImageTransformOperation = Extract<WorkflowNode, { type: "image-transform" }>["data"]["operation"];
type SafetyContentPolicy = Extract<WorkflowNode, { type: "safety-check" }>["data"]["contentPolicy"];
type OutputFormat = Extract<WorkflowNode, { type: "output" }>["data"]["format"];

type WorkflowCanvasProps = {
  workflow: WorkflowDocument;
  workflowName: string;
  workflowId: string | null;
  models: ModelOption[];
  generationBlockReason: string | null;
  catalogueSelection: CatalogueSelection;
  onWorkflowChange(workflow: WorkflowDocument): void;
  onWorkflowNameChange(name: string): void;
  onWorkflowLoaded(input: { workflow: WorkflowDocument; name: string; workflowId: string | null }): void;
  onNotice(message: string): void;
};

const activeGenerationStatuses = new Set([
  "QUEUED",
  "VALIDATING",
  "STARTING",
  "LOADING_MODEL",
  "GENERATING",
  "POST_PROCESSING",
  "UPLOADING"
]);

function compact(text: string, maxLength = 72) {
  return text.length > maxLength ? `${text.slice(0, maxLength - 1)}...` : text;
}

function toInt(value: string, fallback: number | undefined) {
  const parsed = Number(value);
  return value.trim() && Number.isFinite(parsed) ? parsed : fallback ?? 0;
}

function toNumber(value: string, fallback: number | undefined) {
  const parsed = Number(value);
  return value.trim() && Number.isFinite(parsed) ? parsed : fallback ?? 0;
}

function hasEditableModel(node: WorkflowNode): node is ModelEditableNode {
  return (
    node.type === "llm-prompt" ||
    node.type === "text-to-image" ||
    node.type === "image-to-image" ||
    node.type === "image-analysis" ||
    node.type === "image-transform"
  );
}

function patchWorkflowNodeData(node: WorkflowNode, data: Record<string, unknown>): WorkflowNode {
  return { ...node, data: { ...node.data, ...data } } as WorkflowNode;
}

function describeNode(node: WorkflowNode, models: ModelOption[]): StudioNodeData {
  const copy = getWorkflowNodeDefinition(node.type);

  switch (node.type) {
    case "llm-prompt":
    case "text-to-image":
    case "image-to-image":
    case "image-analysis": {
      const model = models.find((option) => option.id === node.data.modelId);
      return {
        label: model?.name ?? copy.label,
        eyebrow: copy.eyebrow,
        body: model ? `${model.route ?? "route"} - ${model.id}` : node.data.modelId
      };
    }
    case "image-transform": {
      const model = node.data.modelId ? models.find((option) => option.id === node.data.modelId) : null;
      return { label: copy.label, eyebrow: copy.eyebrow, body: `${node.data.operation}${model ? ` - ${model.name}` : ""}` };
    }
    case "prompt-input":
    case "negative-prompt":
      return { label: copy.label, eyebrow: copy.eyebrow, body: compact(node.data.prompt) };
    case "starting-image":
      return { label: copy.label, eyebrow: copy.eyebrow, body: `${node.data.assetId} - strength ${node.data.strength}` };
    case "dimensions":
      return { label: copy.label, eyebrow: copy.eyebrow, body: `${node.data.width} x ${node.data.height} - batch ${node.data.batch}` };
    case "seed":
      return { label: copy.label, eyebrow: copy.eyebrow, body: `${node.data.seed}${node.data.locked ? " - locked" : ""}` };
    case "safety-check":
      return {
        label: copy.label,
        eyebrow: copy.eyebrow,
        body: `${node.data.contentPolicy} moderation${node.data.watermark ? " - watermark" : ""}`
      };
    case "output":
      return {
        label: copy.label,
        eyebrow: copy.eyebrow,
        body: `${node.data.format.toUpperCase()} - ${node.data.privateByDefault ? "private" : "visibility review"}`
      };
  }
}

function renderIconForKey(iconKey: WorkflowIconKey) {
  switch (iconKey) {
    case "brain":
      return <BrainCircuit size={16} aria-hidden="true" />;
    case "message":
      return <MessageSquareText size={16} aria-hidden="true" />;
    case "ban":
      return <Ban size={16} aria-hidden="true" />;
    case "file-image":
      return <FileImage size={16} aria-hidden="true" />;
    case "ruler":
      return <Ruler size={16} aria-hidden="true" />;
    case "sliders":
      return <SlidersHorizontal size={16} aria-hidden="true" />;
    case "captions":
      return <Captions size={16} aria-hidden="true" />;
    case "shield":
      return <ShieldCheck size={16} aria-hidden="true" />;
    case "paintbrush":
      return <Paintbrush size={16} aria-hidden="true" />;
    case "image":
      return <ImageIcon size={16} aria-hidden="true" />;
  }
}

function renderIconForType(type?: string) {
  if (!type || !(type in workflowNodeDefinitions)) {
    return <ImageIcon size={16} aria-hidden="true" />;
  }

  return renderIconForKey(getWorkflowNodeDefinition(type as ApprovedNodeType).iconKey);
}

const portLabels: Record<string, string> = {
  prompt: "Prompt",
  negative: "Negative prompt",
  context: "Context",
  image: "Image",
  text: "Text",
  json: "Structured data",
  dimensions: "Dimensions",
  seed: "Seed",
  metadata: "Metadata",
  approvedImage: "Approved image",
  safety: "Safety report"
};

const portDataTypes: Record<PortType, { label: string; description: string }> = {
  text: { label: "Text", description: "Text string" },
  image: { label: "Image", description: "Image data" },
  json: { label: "JSON", description: "Structured JSON data" },
  dimensions: { label: "Dimensions", description: "Width, height and batch size" },
  seed: { label: "Integer", description: "Integer seed value" }
};

function WorkflowNodeView({ data, type, isConnectable }: NodeProps) {
  const nodeData = data as StudioNodeData;
  const icon = renderIconForType(type);
  const ports = type && type in workflowNodeDefinitions
    ? getWorkflowNodeDefinition(type as ApprovedNodeType).ports
    : { inputs: {}, outputs: {} };

  return (
    <div className={`workflow-node ${type ?? ""}`}>
      <div className="node-header">
        <div className="node-icon">{icon}</div>
        <div>
          <p className="node-eyebrow">{nodeData.eyebrow}</p>
          <p className="node-label" title={nodeData.label}>{nodeData.label}</p>
        </div>
      </div>
      <div className="node-body">{nodeData.body}</div>
      <div className="node-ports">
        {(["inputs", "outputs"] as const).map((direction) => {
          const input = direction === "inputs";
          const connections = (input ? nodeData.connectedInputs : nodeData.connectedOutputs) ?? [];
          const entries = Object.entries(ports[direction]);
          return (
            <section className={`node-port-section ${direction}`} key={direction} aria-label={input ? "Inputs" : "Outputs"}>
              <p className="node-port-heading">{input ? "Inputs" : "Outputs"}</p>
              {entries.length === 0 ? <p className="node-ports-empty">{input ? "No inputs" : "No outputs"}</p> : entries.map(([handle, dataType]) => {
                const label = portLabels[handle] ?? handle;
                const datatype = portDataTypes[dataType];
                const connected = connections.includes(handle);
                const status = connected ? "Connected" : "Not connected";
                const description = `${label} ${input ? "input" : "output"}: ${datatype.description}. ${status}.`;
                return (
                  <div className={connected ? "node-port connected" : "node-port"} key={handle}>
                    <Handle
                      className={`node-handle port-type-${dataType}`}
                      id={handle}
                      isConnectable={isConnectable}
                      position={input ? Position.Left : Position.Right}
                      type={input ? "target" : "source"}
                      aria-label={description}
                      title={description}
                    />
                    <span className="node-port-name">{label}</span>
                    <span className={`node-port-type port-type-${dataType}`} title={datatype.description}>{datatype.label}</span>
                    <span className="node-port-status">{status}</span>
                  </div>
                );
              })}
            </section>
          );
        })}
      </div>
    </div>
  );
}

const MemoWorkflowNodeView = memo(WorkflowNodeView, (previous, next) =>
  previous.data === next.data && previous.type === next.type && previous.isConnectable === next.isConnectable
);

const nodeTypes = {
  "prompt-input": MemoWorkflowNodeView,
  "negative-prompt": MemoWorkflowNodeView,
  "starting-image": MemoWorkflowNodeView,
  dimensions: MemoWorkflowNodeView,
  seed: MemoWorkflowNodeView,
  "llm-prompt": MemoWorkflowNodeView,
  "text-to-image": MemoWorkflowNodeView,
  "image-to-image": MemoWorkflowNodeView,
  "image-analysis": MemoWorkflowNodeView,
  "safety-check": MemoWorkflowNodeView,
  "image-transform": MemoWorkflowNodeView,
  output: MemoWorkflowNodeView
};

const initialFitViewOptions = { padding: 0.18 };

type WorkflowDiagramProps = {
  nodes: StudioFlowNode[];
  edges: Edge[];
  onNodesChange(changes: NodeChange<StudioFlowNode>[]): void;
  onEdgesChange(changes: EdgeChange<Edge>[]): void;
  onConnect(connection: Connection): void;
  onSelectNode(id: string | null): void;
};

// Keep animation-frame updates inside React Flow, away from workflow validation,
// model lookups, the inspector and the rest of the Studio screen.
const WorkflowDiagram = memo(function WorkflowDiagram({ nodes, edges, onNodesChange, onEdgesChange, onConnect, onSelectNode }: WorkflowDiagramProps) {
  const [initialNodes] = useState(() => nodes);
  const [instance, setInstance] = useState<ReactFlowInstance<StudioFlowNode, Edge> | null>(null);

  useLayoutEffect(() => {
    instance?.setNodes((current) => reconcileCanvasNodes(current, nodes));
  }, [instance, nodes]);

  const selectNode = useCallback((_event: unknown, node: StudioFlowNode) => onSelectNode(node.id), [onSelectNode]);
  const clearSelection = useCallback(() => onSelectNode(null), [onSelectNode]);

  return (
    <div className="flow-canvas" aria-label="Workflow editor">
      <ReactFlow<StudioFlowNode, Edge>
        colorMode="light"
        defaultNodes={initialNodes}
        edges={edges}
        fitView
        fitViewOptions={initialFitViewOptions}
        maxZoom={1.8}
        minZoom={0.35}
        nodeDragThreshold={3}
        nodeTypes={nodeTypes}
        nodesDraggable
        onConnect={onConnect}
        onEdgesChange={onEdgesChange}
        onInit={setInstance}
        onNodeClick={selectNode}
        onNodesChange={onNodesChange}
        onPaneClick={clearSelection}
      >
        <Background color="#cadad4" gap={22} />
        <MiniMap maskColor="rgba(247, 250, 248, 0.72)" pannable zoomable />
        <Controls showInteractive={false} />
      </ReactFlow>
    </div>
  );
});

function errorMessage(payload: unknown, fallback: string) {
  if (payload && typeof payload === "object" && "error" in payload) {
    const error = (payload as { error?: unknown }).error;
    if (typeof error === "string") {
      return error;
    }
    if (error && typeof error === "object" && "message" in error) {
      const message = (error as { message?: unknown }).message;
      if (typeof message === "string") {
        return message;
      }
    }
  }

  if (payload && typeof payload === "object" && "issues" in payload) {
    const issues = (payload as { issues?: unknown }).issues;
    if (Array.isArray(issues) && typeof issues[0] === "string") {
      return issues[0];
    }
  }

  return fallback;
}

function fileLooksLikeJson(file: File) {
  const hasJsonName = file.name.toLowerCase().endsWith(".json");
  const hasJsonMime =
    file.type === "" ||
    file.type === "application/json" ||
    file.type === "text/json" ||
    file.type.endsWith("+json");

  return hasJsonName && hasJsonMime;
}

export function WorkflowCanvas({
  workflow,
  workflowName,
  workflowId,
  models,
  generationBlockReason,
  catalogueSelection,
  onWorkflowChange,
  onWorkflowNameChange,
  onWorkflowLoaded,
  onNotice
}: WorkflowCanvasProps) {
  const [status, setStatus] = useState<"idle" | "validating" | "validated" | "saving" | "generating" | "error">("idle");
  const [message, setMessage] = useState("Ready");
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null);
  const [activeTab, setActiveTab] = useState<"graph" | "version" | "audit">("graph");
  const [workflows, setWorkflows] = useState<WorkflowSummaryDTO[]>([]);
  const [workflowListState, setWorkflowListState] = useState<"idle" | "loading" | "auth" | "error">("idle");
  const [validationMessages, setValidationMessages] = useState<string[]>([]);
  const [defaultsPreview, setDefaultsPreview] = useState<{ preview: DefaultsPreview; modelName: string } | null>(null);
  const handledCatalogueNonce = useRef<number | null>(null);
  const importInputRef = useRef<HTMLInputElement | null>(null);
  const submissionBusy = useRef(false);
  const submission = useRef<{ fingerprint: string; key: string } | null>(null);
  const selectedNode = workflow.nodes.find((node) => node.id === selectedNodeId) ?? null;
  const selectedModelNode = selectedNode && hasEditableModel(selectedNode) ? selectedNode : null;
  const estimatedCredits = estimateGenerationCredits(workflow, models);
  const constraintIssues = workflowModelConstraintIssues(workflow);
  const connectedImageNode = selectedNode?.type === "dimensions" ? workflow.nodes.find((node) => (node.type === "text-to-image" || node.type === "image-to-image") && workflow.edges.some((edge) => edge.source === selectedNode.id && edge.target === node.id && edge.targetHandle === "dimensions")) : undefined;
  const selectedDefinition = selectedModelNode ? getModelById(selectedModelNode.data.modelId ?? "") : connectedImageNode && "modelId" in connectedImageNode.data ? getModelById(connectedImageNode.data.modelId ?? "") : undefined;
  const localValidation = validateWorkflow(workflow, { models });
  const blockedReason = generationBlockReason ?? (!localValidation.ok ? localValidation.issues[0] : null);
  const busy = ["validating", "saving", "generating"].includes(status);

  function reviewDefaults(nodeId?: string) {
    const modelId = nodeId && selectedDefinition ? selectedDefinition.id : workflow.selectedModel;
    const definition = getModelById(modelId ?? "");
    if (!definition) { setMessage("Choose a reviewed model before applying defaults."); return; }
    const preview = previewModelDefaults(workflow, definition, nodeId && connectedImageNode ? connectedImageNode.id : nodeId);
    if (!preview.changes.length) { setMessage(preview.skipped[0] ?? "Current values already match model defaults."); return; }
    setDefaultsPreview({ preview, modelName: definition.name });
  }

  useEffect(() => {
    if (!catalogueSelection) {
      return;
    }

    if (handledCatalogueNonce.current === catalogueSelection.nonce) {
      return;
    }

    handledCatalogueNonce.current = catalogueSelection.nonce;

    queueMicrotask(() => {
      const result = addWorkflowNode(workflow, catalogueSelection.type);

      if (!result.ok) {
        const issue = result.issues[0] ?? "Node could not be added.";
        setStatus("error");
        setMessage(issue);
        onNotice(issue);
        return;
      }

      onWorkflowChange(result.value.workflow);
      setSelectedNodeId(result.value.selectedNodeId);
      setActiveTab("graph");
      setStatus("idle");
      setMessage(result.notices[0] ?? "Node added. Connect it before generation.");
      onNotice(result.notices[0] ?? "Node added. Connect it before generation.");
    });
  }, [catalogueSelection, onNotice, onWorkflowChange, workflow]);

  const flowNodes = useMemo<Node<StudioNodeData>[]>(
    () =>
      workflow.nodes.map((node) => ({
        id: node.id,
        type: node.type,
        position: node.position,
        data: {
          ...describeNode(node, models),
          connectedInputs: workflow.edges.filter((edge) => edge.target === node.id).map((edge) => edge.targetHandle),
          connectedOutputs: workflow.edges.filter((edge) => edge.source === node.id).map((edge) => edge.sourceHandle)
        },
        selected: node.id === selectedNodeId
      })),
    [models, selectedNodeId, workflow.nodes, workflow.edges]
  );

  const flowEdges = useMemo<Edge[]>(
    () =>
      workflow.edges.map((edge) => ({
        ...edge,
        markerEnd: { type: MarkerType.ArrowClosed }
      })),
    [workflow.edges]
  );

  function updateNode(nodeId: string, updater: (node: WorkflowNode) => WorkflowNode) {
    onWorkflowChange({
      ...workflow,
      nodes: workflow.nodes.map((node) => (node.id === nodeId ? updater(node) : node))
    });
  }

  function updateSelectedModelId(nodeId: string, modelId: string) {
    const model = models.find((option) => option.id === modelId);

    onWorkflowChange({
      ...workflow,
      selectedModel: modelId,
      nodes: workflow.nodes.map((node) =>
        node.id === nodeId && hasEditableModel(node)
          ? patchWorkflowNodeData(node, { modelId, ...(model?.route ? { route: model.route } : {}) })
          : node
      )
    });
  }

  const handleNodesChange = useCallback((changes: NodeChange<StudioFlowNode>[]) => {
    let nextWorkflow = commitCanvasPositions(workflow, changes);

    for (const change of changes) {
      if (change.type === "select") {
        setSelectedNodeId((current) => change.selected ? change.id : current === change.id ? null : current);
      }

      if (change.type === "remove") {
        const result = removeWorkflowNode(nextWorkflow, change.id, { selectedNodeId });

        if (result.ok) {
          nextWorkflow = result.value.workflow;
          setSelectedNodeId(result.value.selectedNodeId);
          setStatus("idle");
          setMessage(result.notices[0] ?? "Node removed.");
        }
      }
    }

    if (nextWorkflow !== workflow) {
      onWorkflowChange(nextWorkflow);
    }
  }, [workflow, onWorkflowChange, selectedNodeId]);

  const handleEdgesChange = useCallback((changes: EdgeChange<Edge>[]) => {
    const removedIds = changes.filter((change) => change.type === "remove").map((change) => change.id);

    if (removedIds.length === 0) {
      return;
    }

    onWorkflowChange({
      ...workflow,
      edges: workflow.edges.filter((edge) => !removedIds.includes(edge.id))
    });
    setStatus("idle");
    setMessage("Connection removed.");
  }, [workflow, onWorkflowChange]);

  const handleConnect = useCallback((connection: Connection) => {
    if (!connection.source || !connection.target || !connection.sourceHandle || !connection.targetHandle) {
      setStatus("error");
      setMessage("Connection needs a source and target handle.");
      return;
    }

    const result = addWorkflowEdge(workflow, {
      source: connection.source,
      sourceHandle: connection.sourceHandle,
      target: connection.target,
      targetHandle: connection.targetHandle
    });

    if (!result.ok) {
      const issue = result.issues[0] ?? "Connection could not be added.";
      setStatus("error");
      setMessage(issue);
      onNotice(issue);
      return;
    }

    onWorkflowChange(result.value.workflow);
    setStatus("idle");
    setMessage(result.notices[0] ?? "Connection added. Run Validate before generation.");
  }, [workflow, onWorkflowChange, onNotice]);

  async function validateCurrentWorkflow() {
    setStatus("validating");
    setMessage("Validating graph against server policy...");
    setValidationMessages([]);

    try {
      const response = await fetchWithTimeout("/api/workflows/validate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(workflow)
      });
      const payload = (await response.json().catch(() => null)) as
        | { ok?: boolean; estimatedCredits?: number; warnings?: string[]; issues?: string[]; error?: { message?: string } }
        | null;

      if (!response.ok || payload?.ok !== true) {
        const issues = payload?.issues ?? [apiErrorMessage(payload, "Workflow validation failed.")];
        setStatus("error");
        setValidationMessages(issues);
        setMessage(issues[0] ?? "Workflow validation failed.");
        onNotice(issues[0] ?? "Workflow validation failed.");
        setActiveTab("audit");
        return false;
      }

      const warnings = payload?.warnings ?? [];
      setStatus("validated");
      setValidationMessages(warnings);
      setMessage(`Valid workflow - estimated ${payload?.estimatedCredits ?? estimatedCredits} credits.`);
      onNotice(`Workflow validated at ${payload?.estimatedCredits ?? estimatedCredits} estimated credits.`);
      return true;
    } catch {
      const failure = "Workflow validation request failed. Check your connection, then retry Validate.";
      setStatus("error");
      setMessage(failure);
      setValidationMessages([failure]);
      setActiveTab("audit");
      onNotice(failure);
      return false;
    }
  }

  async function saveWorkflow() {
    setStatus("saving");
    setMessage("Saving workflow revision...");

    try {
      const endpoint = workflowId ? `/api/workflows/${encodeURIComponent(workflowId)}` : "/api/workflows";
      const response = await fetchWithTimeout(endpoint, {
        method: workflowId ? "PUT" : "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: workflowName,
          workflow
        })
      });
      const payload = (await response.json().catch(() => null)) as
        | {
            workflow?: WorkflowSummaryDTO;
            version?: { versionNumber?: number };
            warnings?: string[];
            error?: { message?: string };
          }
        | null;

      if (!response.ok || !payload?.workflow) {
        setStatus("error");
        const failure = errorMessage(payload, "Workflow could not be saved.");
        setMessage(failure);
        onNotice(failure);
        return;
      }

      onWorkflowLoaded({ workflow, name: payload.workflow.name, workflowId: payload.workflow.id });
      setStatus("validated");
      setValidationMessages(payload.warnings ?? []);
      setMessage(`Saved revision ${payload.version?.versionNumber ?? payload.workflow.revision}.`);
      onNotice(`Saved ${payload.workflow.name}.`);
      announceStudioDataChanged();
    } catch {
      setStatus("error");
      setMessage("Save could not be confirmed. Check your connection and refresh the workflow list before retrying.");
    }
  }

  async function loadWorkflowList() {
    setWorkflowListState("loading");
    const response = await fetch("/api/workflows", { cache: "no-store" });

    if (response.status === 401) {
      setWorkflows([]);
      setWorkflowListState("auth");
      return;
    }

    const payload = (await response.json().catch(() => null)) as { workflows?: WorkflowSummaryDTO[] } | null;

    if (!response.ok) {
      setWorkflowListState("error");
      return;
    }

    setWorkflows(payload?.workflows ?? []);
    setWorkflowListState("idle");
  }

  async function loadWorkflow(id: string) {
    setMessage("Loading workflow...");
    const response = await fetch(`/api/workflows/${encodeURIComponent(id)}`, { cache: "no-store" });
    const payload = (await response.json().catch(() => null)) as { workflow?: WorkflowDetailDTO; error?: { message?: string } } | null;

    if (!response.ok || !payload?.workflow?.currentVersion?.graph) {
      setStatus("error");
      const failure = errorMessage(payload, "Workflow could not be loaded.");
      setMessage(failure);
      onNotice(failure);
      return;
    }

    onWorkflowLoaded({
      workflow: payload.workflow.currentVersion.graph,
      name: payload.workflow.name,
      workflowId: payload.workflow.id
    });
    setSelectedNodeId(null);
    setStatus("idle");
    setMessage(`Loaded ${payload.workflow.name}.`);
    onNotice(`Loaded ${payload.workflow.name}.`);
  }

  async function archiveCurrentWorkflow() {
    if (!workflowId) {
      onWorkflowLoaded({ workflow: cloneWorkflowDocument(baseTextToImageWorkflow), name: "Untitled workflow", workflowId: null });
      setSelectedNodeId(null);
      setStatus("idle");
      setMessage("Unsaved workflow cleared.");
      return;
    }

    const confirmed = window.confirm("Archive this workflow?");
    if (!confirmed) {
      return;
    }

    const response = await fetch(`/api/workflows/${encodeURIComponent(workflowId)}`, {
      method: "DELETE"
    });
    const payload = (await response.json().catch(() => null)) as { error?: { message?: string } } | null;

    if (!response.ok) {
      setStatus("error");
      const failure = errorMessage(payload, "Workflow could not be archived.");
      setMessage(failure);
      onNotice(failure);
      return;
    }

    onWorkflowLoaded({ workflow: cloneWorkflowDocument(baseTextToImageWorkflow), name: "Untitled workflow", workflowId: null });
    setSelectedNodeId(null);
    setStatus("idle");
    setMessage("Workflow archived.");
    onNotice("Workflow archived.");
    announceStudioDataChanged();
  }

  async function generateCurrentWorkflow() {
    if (submissionBusy.current || blockedReason) return;
    submissionBusy.current = true;
    try {
      const valid = await validateCurrentWorkflow();

      if (!valid) {
        return;
      }

      setStatus("generating");
      setMessage("Submitting workflow to generation admission...");

      const fingerprint = JSON.stringify({ workflow, workflowId, workflowName });
      if (submission.current?.fingerprint !== fingerprint) submission.current = { fingerprint, key: crypto.randomUUID() };
      const response = await fetchWithTimeout("/api/generations", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          workflow,
          workflowId: workflowId ?? undefined,
          workflowName,
          idempotencyKey: submission.current.key
        })
      });
      const payload = (await response.json().catch(() => null)) as
        | { job?: { id: string; status: string; errorMessage?: string; executionEnvironment?: string }; error?: { code?: string; message?: string; details?: unknown } }
        | null;

      if (!response.ok || !payload?.job) {
        setStatus("error");
        const failure = apiErrorMessage(payload, "Generation admission failed.");
        setMessage(failure);
        setValidationMessages([failure]);
        onNotice(failure);
        setActiveTab("audit");
        return;
      }

      submission.current = null;
      const failed = payload.job.status === "FAILED";
      const resultMessage = failed ? payload.job.errorMessage ?? "Generation failed. Check the queue for details." : payload.job.executionEnvironment === "development-local" ? `Development placeholder job ${payload.job.id} accepted; no real image is generated.` : `Job ${payload.job.id} accepted (${payload.job.status}). An image is available only after successful completion.`;
      setStatus(failed ? "error" : activeGenerationStatuses.has(payload.job.status) ? "validated" : "idle");
      setMessage(resultMessage);
      onNotice(resultMessage);
      announceStudioDataChanged();
    } catch {
      const failure = "Job submission could not be confirmed. Check the queue, then retry; the unchanged workflow reuses the same submission key.";
      setStatus("error");
      setMessage(failure);
      onNotice(failure);
      announceStudioDataChanged();
    } finally { submissionBusy.current = false; }
  }

  function createNewWorkflow() {
    const next = cloneWorkflowDocument(baseTextToImageWorkflow);
    onWorkflowLoaded({ workflow: next, name: "Untitled workflow", workflowId: null });
    setSelectedNodeId(null);
    setStatus("idle");
    setMessage("New workflow ready.");
  }

  function removeNodeById(nodeId: string) {
    const result = removeWorkflowNode(workflow, nodeId, { selectedNodeId });

    if (!result.ok) {
      const issue = result.issues[0] ?? "Node could not be removed.";
      setStatus("error");
      setMessage(issue);
      onNotice(issue);
      return;
    }

    onWorkflowChange(result.value.workflow);
    setSelectedNodeId(result.value.selectedNodeId);
    setStatus("idle");
    setMessage(result.notices[0] ?? "Node removed.");
    onNotice(result.notices[0] ?? "Node removed.");
  }

  function exportCurrentWorkflow() {
    const exportResult = createWorkflowExportPayload(workflow);

    if (!exportResult.ok) {
      const issue = exportResult.issues[0] ?? "Workflow is invalid and was not exported.";
      setStatus("error");
      setValidationMessages(exportResult.issues);
      setMessage(issue);
      onNotice(issue);
      setActiveTab("audit");
      return;
    }

    const blob = new Blob([stringifyWorkflowDocument(exportResult.value)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");

    link.href = url;
    link.download = sanitizeWorkflowFilename(workflowName);
    link.rel = "noopener";
    document.body.append(link);
    link.click();
    link.remove();
    window.setTimeout(() => URL.revokeObjectURL(url), 0);

    setStatus("validated");
    setValidationMessages(exportResult.notices);
    setMessage("Workflow JSON exported.");
    onNotice(`Exported ${link.download}.`);
  }

  async function importWorkflowFile(file: File) {
    if (!fileLooksLikeJson(file)) {
      const issue = "Choose a .json workflow file.";
      setStatus("error");
      setMessage(issue);
      onNotice(issue);
      return;
    }

    if (file.size > maxWorkflowImportBytes) {
      const issue = `Workflow file exceeds the ${Math.round(maxWorkflowImportBytes / 1024)} KB import limit.`;
      setStatus("error");
      setMessage(issue);
      onNotice(issue);
      return;
    }

    let text: string;

    try {
      text = await file.text();
    } catch {
      const issue = "Workflow file could not be read as text.";
      setStatus("error");
      setMessage(issue);
      onNotice(issue);
      return;
    }

    const importResult = parseWorkflowJsonText(text);

    if (!importResult.ok) {
      const issue = importResult.issues[0] ?? "Workflow import failed.";
      setStatus("error");
      setValidationMessages(importResult.issues);
      setMessage(issue);
      onNotice(issue);
      setActiveTab("audit");
      return;
    }

    const importedName = file.name.replace(/\.json$/i, "").trim() || "Imported workflow";

    onWorkflowLoaded({
      workflow: cloneWorkflowDocument(importResult.value),
      name: importedName,
      workflowId: null
    });
    setSelectedNodeId(null);
    setActiveTab("graph");
    setStatus("idle");
    setValidationMessages(importResult.notices);
    setMessage(importResult.notices[0] ?? "Workflow imported as an unsaved document.");
    onNotice(
      importResult.notices.length > 0
        ? `Imported ${importedName}. ${importResult.notices[0]}`
        : `Imported ${importedName} as an unsaved workflow.`
    );
  }

  function openImportPicker() {
    const confirmed = window.confirm("Importing a workflow will replace the current unsaved canvas. Continue?");

    if (!confirmed) {
      return;
    }

    importInputRef.current?.click();
  }

  function renderNodeEditor() {
    if (!selectedNode) {
      return null;
    }

    return (
      <div className="canvas-drawer">
        <div className="item-top">
          <div>
            <p className="item-title">{getWorkflowNodeDefinition(selectedNode.type).label}</p>
            <p className="item-meta">{selectedNode.id}</p>
          </div>
          <button
            className="button subtle compact-button"
            onClick={() => removeNodeById(selectedNode.id)}
            type="button"
          >
            <Trash2 size={13} aria-hidden="true" />
            Remove
          </button>
        </div>
        {selectedDefinition ? <div className="model-node-guidance"><p className="item-meta">{selectedDefinition.name} · {selectedDefinition.providerModelId}. {selectedDefinition.limitsNote}</p><button className="button subtle" onClick={() => reviewDefaults(selectedNode.id)} type="button">Auto-fill node from model</button></div> : null}
        {constraintIssues.filter((issue) => issue.nodeId === selectedNode.id).map((issue) => <p className="model-constraint-warning" role="alert" key={`${issue.field}-${issue.message}`}>{issue.message}</p>)}
        <div className="node-editor-grid">
          {selectedModelNode ? (
            <label>
              <span>Model</span>
              <select
                value={selectedModelNode.data.modelId ?? ""}
                onChange={(event) => {
                  const modelId = event.target.value;
                  updateSelectedModelId(selectedModelNode.id, modelId);
                }}
              >
                {[selectedModelNode.data.modelId ?? "", ...models.map((model) => model.id)]
                  .filter((modelId, index, values) => modelId && values.indexOf(modelId) === index)
                  .map((modelId) => (
                    <option key={modelId} value={modelId} disabled={Boolean(models.find((model) => model.id === modelId) && !getModelById(modelId)?.capabilities.includes(selectedModelNode.type))}>
                      {models.find((model) => model.id === modelId)?.name ?? modelId}
                    </option>
                  ))}
              </select>
            </label>
          ) : null}
          {selectedModelNode ? (
            <label>
              <span>Route</span>
              <input
                readOnly
                value={models.find((model) => model.id === selectedModelNode.data.modelId)?.route ?? selectedModelNode.data.route ?? "unresolved"}
              />
            </label>
          ) : null}
          {selectedNode.type === "prompt-input" || selectedNode.type === "negative-prompt" ? (
            <label className="wide-field">
              <span>Prompt</span>
              <textarea
                rows={3}
                value={selectedNode.data.prompt}
                onChange={(event) =>
                  updateNode(selectedNode.id, (node) =>
                    node.type === selectedNode.type ? { ...node, data: { ...node.data, prompt: event.target.value } } : node
                  )
                }
              />
            </label>
          ) : null}
          {selectedNode.type === "starting-image" ? (
            <>
              <label>
                <span>Asset ID</span>
                <input
                  value={selectedNode.data.assetId}
                  onChange={(event) =>
                    updateNode(selectedNode.id, (node) =>
                      node.type === "starting-image" ? { ...node, data: { ...node.data, assetId: event.target.value } } : node
                    )
                  }
                />
              </label>
              <label>
                <span>Strength</span>
                <input
                  max={1}
                  min={0}
                  step={0.01}
                  type="number"
                  value={selectedNode.data.strength ?? ""}
                  aria-invalid={constraintIssues.some((issue) => issue.nodeId === selectedNode.id && (issue.field === "strength"))}
                  className={constraintIssues.some((issue) => issue.nodeId === selectedNode.id && (issue.field === "strength")) ? "model-invalid-input" : undefined}
                  disabled={Boolean(selectedDefinition?.unsupportedParameters.includes("strength"))}
                  onChange={(event) =>
                    updateNode(selectedNode.id, (node) =>
                      node.type === "starting-image"
                        ? { ...node, data: { ...node.data, strength: toNumber(event.target.value, node.data.strength) } }
                        : node
                    )
                  }
                />
              </label>
            </>
          ) : null}
          {selectedNode.type === "dimensions" ? (
            <>
              <label>
                <span>Width</span>
                <input
                  min={256}
                  max={4096}
                  step={1}
                  type="number"
                  value={selectedNode.data.width}
                  aria-invalid={constraintIssues.some((issue) => issue.nodeId === selectedNode.id && (issue.field === "width" || issue.field === "resolution"))}
                  className={constraintIssues.some((issue) => issue.nodeId === selectedNode.id && (issue.field === "width" || issue.field === "resolution")) ? "model-invalid-input" : undefined}
                  onChange={(event) =>
                    updateNode(selectedNode.id, (node) =>
                      node.type === "dimensions"
                        ? { ...node, data: { ...node.data, width: toInt(event.target.value, node.data.width) } }
                        : node
                    )
                  }
                />
              </label>
              <label>
                <span>Height</span>
                <input
                  min={256}
                  max={4096}
                  step={1}
                  type="number"
                  value={selectedNode.data.height}
                  aria-invalid={constraintIssues.some((issue) => issue.nodeId === selectedNode.id && (issue.field === "height" || issue.field === "resolution"))}
                  className={constraintIssues.some((issue) => issue.nodeId === selectedNode.id && (issue.field === "height" || issue.field === "resolution")) ? "model-invalid-input" : undefined}
                  onChange={(event) =>
                    updateNode(selectedNode.id, (node) =>
                      node.type === "dimensions"
                        ? { ...node, data: { ...node.data, height: toInt(event.target.value, node.data.height) } }
                        : node
                    )
                  }
                />
              </label>
              <label>
                <span>Batch</span>
                <input
                  min={1}
                  max={4}
                  type="number"
                  value={selectedNode.data.batch}
                  aria-invalid={constraintIssues.some((issue) => issue.nodeId === selectedNode.id && (issue.field === "batch"))}
                  className={constraintIssues.some((issue) => issue.nodeId === selectedNode.id && (issue.field === "batch")) ? "model-invalid-input" : undefined}
                  onChange={(event) =>
                    updateNode(selectedNode.id, (node) =>
                      node.type === "dimensions"
                        ? { ...node, data: { ...node.data, batch: toInt(event.target.value, node.data.batch) } }
                        : node
                    )
                  }
                />
              </label>
            </>
          ) : null}
          {selectedNode.type === "seed" ? (
            <>
              <label>
                <span>Seed</span>
                <input
                  min={0}
                  type="number"
                  value={selectedNode.data.seed ?? ""}
                  aria-invalid={constraintIssues.some((issue) => issue.nodeId === selectedNode.id && (issue.field === "seed"))}
                  className={constraintIssues.some((issue) => issue.nodeId === selectedNode.id && (issue.field === "seed")) ? "model-invalid-input" : undefined}
                  disabled={Boolean(selectedDefinition?.unsupportedParameters.includes("seed"))}
                  onChange={(event) =>
                    updateNode(selectedNode.id, (node) =>
                      node.type === "seed" ? { ...node, data: { ...node.data, seed: toInt(event.target.value, node.data.seed) } } : node
                    )
                  }
                />
              </label>
              <label className="checkbox-field">
                <input
                  checked={selectedNode.data.locked}
                  onChange={(event) =>
                    updateNode(selectedNode.id, (node) =>
                      node.type === "seed" ? { ...node, data: { ...node.data, locked: event.target.checked } } : node
                    )
                  }
                  type="checkbox"
                />
                <span>Lock seed</span>
              </label>
            </>
          ) : null}
          {selectedNode.type === "llm-prompt" || selectedNode.type === "image-analysis" ? (
            <>
              <label className="wide-field">
                <span>Instruction</span>
                <textarea
                  rows={3}
                  value={selectedNode.data.instruction}
                  onChange={(event) =>
                    updateNode(selectedNode.id, (node) =>
                      node.type === selectedNode.type ? patchWorkflowNodeData(node, { instruction: event.target.value }) : node
                    )
                  }
                />
              </label>
              <label>
                <span>Output</span>
                <select
                  value={selectedNode.data.outputMode}
                  onChange={(event) =>
                    updateNode(selectedNode.id, (node) =>
                      node.type === "llm-prompt"
                        ? patchWorkflowNodeData(node, { outputMode: event.target.value as LlmOutputMode })
                        : node.type === "image-analysis"
                          ? patchWorkflowNodeData(node, { outputMode: event.target.value as ImageAnalysisOutputMode })
                          : node
                    )
                  }
                >
                  {selectedNode.type === "llm-prompt" ? (
                    <>
                      <option value="text">Text</option>
                      <option value="json">JSON</option>
                    </>
                  ) : (
                    <>
                      <option value="caption">Caption</option>
                      <option value="critique">Critique</option>
                      <option value="ranking">Ranking</option>
                      <option value="metadata-json">Metadata JSON</option>
                      <option value="prompt-refinement">Prompt refinement</option>
                    </>
                  )}
                </select>
              </label>
              <label>
                <span>Temperature</span>
                <input
                  min={0}
                  max={2}
                  step={0.1}
                  type="number"
                  value={selectedNode.data.temperature}
                  onChange={(event) =>
                    updateNode(selectedNode.id, (node) =>
                      node.type === selectedNode.type
                        ? patchWorkflowNodeData(node, { temperature: toNumber(event.target.value, node.data.temperature) })
                        : node
                    )
                  }
                />
              </label>
              <label>
                <span>Max tokens</span>
                <input
                  min={1}
                  max={4096}
                  type="number"
                  value={selectedNode.data.maxOutputTokens}
                  onChange={(event) =>
                    updateNode(selectedNode.id, (node) =>
                      node.type === selectedNode.type
                        ? patchWorkflowNodeData(node, { maxOutputTokens: toInt(event.target.value, node.data.maxOutputTokens) })
                        : node
                    )
                  }
                />
              </label>
            </>
          ) : null}
          {selectedNode.type === "text-to-image" || selectedNode.type === "image-to-image" ? (
            <>
              <label className="wide-field">
                <span>Inline prompt</span>
                <textarea
                  rows={3}
                  value={selectedNode.data.prompt}
                  onChange={(event) =>
                    updateNode(selectedNode.id, (node) =>
                      node.type === selectedNode.type ? patchWorkflowNodeData(node, { prompt: event.target.value }) : node
                    )
                  }
                />
              </label>
              <label className="wide-field">
                <span>Negative prompt</span>
                <textarea
                  rows={2}
                  value={selectedNode.data.negativePrompt}
                  onChange={(event) =>
                    updateNode(selectedNode.id, (node) =>
                      node.type === selectedNode.type ? patchWorkflowNodeData(node, { negativePrompt: event.target.value }) : node
                    )
                  }
                />
              </label>
              <label>
                <span>Width</span>
                <input
                  min={256}
                  max={4096}
                  step={1}
                  type="number"
                  value={selectedNode.data.width}
                  aria-invalid={constraintIssues.some((issue) => issue.nodeId === selectedNode.id && (issue.field === "width" || issue.field === "resolution"))}
                  className={constraintIssues.some((issue) => issue.nodeId === selectedNode.id && (issue.field === "width" || issue.field === "resolution")) ? "model-invalid-input" : undefined}
                  onChange={(event) =>
                    updateNode(selectedNode.id, (node) =>
                      node.type === selectedNode.type ? patchWorkflowNodeData(node, { width: toInt(event.target.value, node.data.width) }) : node
                    )
                  }
                />
              </label>
              <label>
                <span>Height</span>
                <input
                  min={256}
                  max={4096}
                  step={1}
                  type="number"
                  value={selectedNode.data.height}
                  aria-invalid={constraintIssues.some((issue) => issue.nodeId === selectedNode.id && (issue.field === "height" || issue.field === "resolution"))}
                  className={constraintIssues.some((issue) => issue.nodeId === selectedNode.id && (issue.field === "height" || issue.field === "resolution")) ? "model-invalid-input" : undefined}
                  onChange={(event) =>
                    updateNode(selectedNode.id, (node) =>
                      node.type === selectedNode.type ? patchWorkflowNodeData(node, { height: toInt(event.target.value, node.data.height) }) : node
                    )
                  }
                />
              </label>
              <label>
                <span>Batch</span>
                <input
                  min={1}
                  max={4}
                  type="number"
                  value={selectedNode.data.batch}
                  aria-invalid={constraintIssues.some((issue) => issue.nodeId === selectedNode.id && (issue.field === "batch"))}
                  className={constraintIssues.some((issue) => issue.nodeId === selectedNode.id && (issue.field === "batch")) ? "model-invalid-input" : undefined}
                  onChange={(event) =>
                    updateNode(selectedNode.id, (node) =>
                      node.type === selectedNode.type ? patchWorkflowNodeData(node, { batch: toInt(event.target.value, node.data.batch) }) : node
                    )
                  }
                />
              </label>
              {selectedNode.type === "image-to-image" ? (
                <label>
                  <span>Strength</span>
                  <input
                    max={1}
                    min={0}
                    step={0.01}
                    type="number"
                    value={selectedNode.data.strength ?? ""}
                  aria-invalid={constraintIssues.some((issue) => issue.nodeId === selectedNode.id && (issue.field === "strength"))}
                  className={constraintIssues.some((issue) => issue.nodeId === selectedNode.id && (issue.field === "strength")) ? "model-invalid-input" : undefined}
                  disabled={Boolean(selectedDefinition?.unsupportedParameters.includes("strength"))}
                    onChange={(event) =>
                      updateNode(selectedNode.id, (node) =>
                        node.type === "image-to-image"
                          ? { ...node, data: { ...node.data, strength: toNumber(event.target.value, node.data.strength) } }
                          : node
                      )
                    }
                  />
                </label>
              ) : null}
              <label>
                <span>Steps</span>
                <input
                  min={1}
                  max={80}
                  type="number"
                  value={selectedNode.data.steps ?? ""}
                  aria-invalid={constraintIssues.some((issue) => issue.nodeId === selectedNode.id && (issue.field === "steps"))}
                  className={constraintIssues.some((issue) => issue.nodeId === selectedNode.id && (issue.field === "steps")) ? "model-invalid-input" : undefined}
                  disabled={Boolean(selectedDefinition?.unsupportedParameters.includes("steps"))}
                  onChange={(event) =>
                    updateNode(selectedNode.id, (node) =>
                      node.type === selectedNode.type ? patchWorkflowNodeData(node, { steps: toInt(event.target.value, node.data.steps) }) : node
                    )
                  }
                />
              </label>
              <label>
                <span>CFG</span>
                <input
                  min={0}
                  max={30}
                  step={0.1}
                  type="number"
                  value={selectedNode.data.cfg ?? ""}
                  aria-invalid={constraintIssues.some((issue) => issue.nodeId === selectedNode.id && (issue.field === "cfg"))}
                  className={constraintIssues.some((issue) => issue.nodeId === selectedNode.id && (issue.field === "cfg")) ? "model-invalid-input" : undefined}
                  disabled={Boolean(selectedDefinition?.unsupportedParameters.includes("cfg"))}
                  onChange={(event) =>
                    updateNode(selectedNode.id, (node) =>
                      node.type === selectedNode.type ? patchWorkflowNodeData(node, { cfg: toNumber(event.target.value, node.data.cfg) }) : node
                    )
                  }
                />
              </label>
              <label>
                <span>Sampler</span>
                <select
                  value={selectedNode.data.sampler ?? ""}
                  disabled={Boolean(selectedDefinition?.unsupportedParameters.includes("sampler"))}
                  onChange={(event) =>
                    updateNode(selectedNode.id, (node) =>
                      node.type === selectedNode.type
                        ? patchWorkflowNodeData(node, { sampler: event.target.value as ImageSampler })
                        : node
                    )
                  }
                >
                  <option value="">Provider-managed sampling</option>
                  <option value="euler">Euler</option>
                  <option value="euler-a">Euler a</option>
                  <option value="dpmpp-2m">DPM++ 2M</option>
                  <option value="dpmpp-sde">DPM++ SDE</option>
                  <option value="uni-pc">UniPC</option>
                </select>
              </label>
              <label>
                <span>Scheduler</span>
                <select
                  value={selectedNode.data.scheduler ?? ""}
                  disabled={Boolean(selectedDefinition?.unsupportedParameters.includes("scheduler"))}
                  onChange={(event) =>
                    updateNode(selectedNode.id, (node) =>
                      node.type === selectedNode.type
                        ? patchWorkflowNodeData(node, { scheduler: event.target.value as ImageScheduler })
                        : node
                    )
                  }
                >
                  <option value="">Provider-managed scheduling</option>
                  <option value="normal">Normal</option>
                  <option value="karras">Karras</option>
                  <option value="exponential">Exponential</option>
                  <option value="sgm-uniform">SGM uniform</option>
                </select>
              </label>
              <label>
                <span>Seed</span>
                <input
                  min={0}
                  type="number"
                  value={selectedNode.data.seed ?? ""}
                  aria-invalid={constraintIssues.some((issue) => issue.nodeId === selectedNode.id && (issue.field === "seed"))}
                  className={constraintIssues.some((issue) => issue.nodeId === selectedNode.id && (issue.field === "seed")) ? "model-invalid-input" : undefined}
                  disabled={Boolean(selectedDefinition?.unsupportedParameters.includes("seed"))}
                  onChange={(event) =>
                    updateNode(selectedNode.id, (node) =>
                      node.type === selectedNode.type ? patchWorkflowNodeData(node, { seed: toInt(event.target.value, node.data.seed) }) : node
                    )
                  }
                />
              </label>
              <label>
                <span>Format</span>
                <select
                  value={selectedNode.data.outputFormat}
                  onChange={(event) =>
                    updateNode(selectedNode.id, (node) =>
                      node.type === selectedNode.type
                        ? patchWorkflowNodeData(node, { outputFormat: event.target.value as ImageOutputFormat })
                        : node
                    )
                  }
                >
                  <option value="png">PNG</option>
                  <option value="webp">WebP</option>
                  <option value="jpeg">JPEG</option>
                </select>
              </label>
              <label className="checkbox-field">
                <input
                  checked={selectedNode.data.deterministicSeed ?? false}
                  disabled={Boolean(selectedDefinition?.unsupportedParameters.includes("deterministicSeed"))}
                  onChange={(event) =>
                    updateNode(selectedNode.id, (node) =>
                      node.type === selectedNode.type ? patchWorkflowNodeData(node, { deterministicSeed: event.target.checked }) : node
                    )
                  }
                  type="checkbox"
                />
                <span>Deterministic seed</span>
              </label>
            </>
          ) : null}
          {selectedNode.type === "image-transform" ? (
            <>
              <label>
                <span>Operation</span>
                <select
                  value={selectedNode.data.operation}
                  onChange={(event) =>
                    updateNode(selectedNode.id, (node) =>
                      node.type === "image-transform"
                        ? { ...node, data: { ...node.data, operation: event.target.value as ImageTransformOperation } }
                        : node
                    )
                  }
                >
                  <option value="upscale">Upscale</option>
                  <option value="background-remove">Background remove</option>
                  <option value="format-convert">Format convert</option>
                  <option value="thumbnail">Thumbnail</option>
                </select>
              </label>
              <label>
                <span>Scale</span>
                <input
                  min={1}
                  max={4}
                  step={0.25}
                  type="number"
                  value={selectedNode.data.scale}
                  onChange={(event) =>
                    updateNode(selectedNode.id, (node) =>
                      node.type === "image-transform"
                        ? { ...node, data: { ...node.data, scale: toNumber(event.target.value, node.data.scale) } }
                        : node
                    )
                  }
                />
              </label>
              <label>
                <span>Format</span>
                <select
                  value={selectedNode.data.outputFormat}
                  onChange={(event) =>
                    updateNode(selectedNode.id, (node) =>
                      node.type === "image-transform"
                        ? { ...node, data: { ...node.data, outputFormat: event.target.value as ImageOutputFormat } }
                        : node
                    )
                  }
                >
                  <option value="png">PNG</option>
                  <option value="webp">WebP</option>
                  <option value="jpeg">JPEG</option>
                </select>
              </label>
            </>
          ) : null}
          {selectedNode.type === "safety-check" ? (
            <>
              <label>
                <span>Policy</span>
                <select
                  value={selectedNode.data.contentPolicy}
                  onChange={(event) =>
                    updateNode(selectedNode.id, (node) =>
                      node.type === "safety-check"
                        ? { ...node, data: { ...node.data, contentPolicy: event.target.value as SafetyContentPolicy } }
                        : node
                    )
                  }
                >
                  <option value="standard">Standard</option>
                  <option value="strict">Strict</option>
                </select>
              </label>
              <label className="checkbox-field">
                <input
                  checked={selectedNode.data.watermark}
                  onChange={(event) =>
                    updateNode(selectedNode.id, (node) =>
                      node.type === "safety-check"
                        ? { ...node, data: { ...node.data, watermark: event.target.checked } }
                        : node
                    )
                  }
                  type="checkbox"
                />
                <span>Watermark</span>
              </label>
            </>
          ) : null}
          {selectedNode.type === "output" ? (
            <>
              <label>
                <span>Format</span>
                <select
                  value={selectedNode.data.format}
                  onChange={(event) =>
                    updateNode(selectedNode.id, (node) =>
                      node.type === "output" ? { ...node, data: { ...node.data, format: event.target.value as OutputFormat } } : node
                    )
                  }
                >
                  <option value="png">PNG</option>
                  <option value="webp">WebP</option>
                  <option value="jpeg">JPEG</option>
                </select>
              </label>
              <label className="checkbox-field">
                <input
                  checked={selectedNode.data.privateByDefault}
                  onChange={(event) =>
                    updateNode(selectedNode.id, (node) =>
                      node.type === "output"
                        ? { ...node, data: { ...node.data, privateByDefault: event.target.checked } }
                        : node
                    )
                  }
                  type="checkbox"
                />
                <span>Private by default</span>
              </label>
            </>
          ) : null}
        </div>
      </div>
    );
  }

  function renderVersionPanel() {
    return (
      <div className="canvas-drawer">
        <div className="workflow-form-row">
          <label>
            <span>Name</span>
            <input value={workflowName} onChange={(event) => onWorkflowNameChange(event.target.value)} maxLength={120} />
          </label>
          <button className="button subtle" onClick={createNewWorkflow} type="button">
            <Plus size={14} aria-hidden="true" />
            New
          </button>
          <button className="button primary" disabled={status === "saving"} onClick={saveWorkflow} type="button">
            <Save size={14} aria-hidden="true" />
            Save
          </button>
          <button className="button subtle" onClick={archiveCurrentWorkflow} type="button">
            <Trash2 size={14} aria-hidden="true" />
            Archive
          </button>
        </div>
        <div className="workflow-form-row">
          <button className="button subtle" onClick={loadWorkflowList} type="button">
            Load workflows
          </button>
          <button className="button subtle" onClick={openImportPicker} type="button">
            <Upload size={14} aria-hidden="true" />
            Import JSON
          </button>
          <button className="button subtle" onClick={exportCurrentWorkflow} type="button">
            <Download size={14} aria-hidden="true" />
            Export JSON
          </button>
          <span className="item-meta">{workflowId ? `Current workflow ${workflowId}` : "Unsaved workflow"}</span>
        </div>
        <input
          accept="application/json,.json"
          aria-label="Import workflow JSON"
          className="visually-hidden"
          onChange={(event) => {
            const file = event.target.files?.[0];
            event.target.value = "";

            if (file) {
              importWorkflowFile(file);
            }
          }}
          ref={importInputRef}
          type="file"
        />
        {workflowListState === "loading" ? <p className="item-meta">Loading workflows...</p> : null}
        {workflowListState === "auth" ? <p className="item-meta">Sign in to save and load workflows.</p> : null}
        {workflowListState === "error" ? <p className="item-meta">Workflow list unavailable.</p> : null}
        {workflowListState === "idle" && workflows.length > 0 ? (
          <div className="saved-workflow-list">
            {workflows.map((savedWorkflow) => (
              <button className="saved-workflow" key={savedWorkflow.id} onClick={() => loadWorkflow(savedWorkflow.id)} type="button">
                <span>{savedWorkflow.name}</span>
                <small>rev {savedWorkflow.revision} - {new Date(savedWorkflow.updatedAt).toLocaleString()}</small>
              </button>
            ))}
          </div>
        ) : null}
        {workflowListState === "idle" && workflows.length === 0 ? (
          <p className="item-meta">No saved workflows found for this account.</p>
        ) : null}
      </div>
    );
  }

  function renderAuditPanel() {
    return (
      <div className="canvas-drawer">
        <p className="item-title">Validation and generation status</p>
        {validationMessages.length > 0 ? (
          <ul className="status-list">
            {validationMessages.map((issue) => (
              <li key={issue}>{issue}</li>
            ))}
          </ul>
        ) : (
          <p className="item-meta">No validation issues reported for the current graph.</p>
        )}
      </div>
    );
  }

  return (
    <div className="canvas-shell">
      <div className="canvas-toolbar">
        <div className="segmented" aria-label="Workflow mode">
          <button className={activeTab === "graph" ? "active" : ""} onClick={() => setActiveTab("graph")} type="button">
            Graph
          </button>
          <button className={activeTab === "version" ? "active" : ""} onClick={() => setActiveTab("version")} type="button">
            Version
          </button>
          <button className={activeTab === "audit" ? "active" : ""} onClick={() => setActiveTab("audit")} type="button">
            Audit
          </button>
        </div>
        <div className="topbar-actions">
          <button className="button subtle" disabled={busy || !getModelById(workflow.selectedModel)} onClick={() => reviewDefaults()} type="button">Apply selected model defaults</button>
          <span className="badge gray">{estimatedCredits} credits est.</span>
          <span className={status === "error" ? "badge warn" : "badge gray"}>{message}</span>
          <button className="button subtle" disabled={busy} onClick={validateCurrentWorkflow} type="button">
            <ShieldCheck size={16} aria-hidden="true" />
            Validate
          </button>
          <button className="button primary" disabled={busy || models.length === 0 || Boolean(blockedReason)} title={blockedReason ?? undefined} aria-describedby={blockedReason ? "generation-block-reason" : undefined} onClick={generateCurrentWorkflow} type="button">
            <Sparkles size={16} aria-hidden="true" />
            Generate
          </button>
        </div>
      </div>
      {defaultsPreview ? <ModelDefaultsConfirmation {...defaultsPreview} onCancel={() => setDefaultsPreview(null)} onConfirm={() => {
        const updated = applyConfirmedModelDefaults(workflow, defaultsPreview.preview, true);
        if (updated === workflow) setMessage("The workflow changed after this preview. Review defaults again.");
        else { onWorkflowChange(updated); setStatus("idle"); setMessage("Confirmed model defaults applied. Validate before generation."); }
        setDefaultsPreview(null);
      }} /> : null}
      {constraintIssues.length ? <div className="model-constraint-summary" role="status">{constraintIssues.map((issue) => <p className="model-constraint-warning" key={`${issue.nodeId}-${issue.field}`}>{issue.message}</p>)}</div> : null}
      {blockedReason ? <p className="form-message" id="generation-block-reason" role="status">Generate unavailable: {blockedReason}</p> : null}
      <WorkflowDiagram nodes={flowNodes} edges={flowEdges} onConnect={handleConnect} onEdgesChange={handleEdgesChange} onNodesChange={handleNodesChange} onSelectNode={setSelectedNodeId} />
      {activeTab === "graph" ? renderNodeEditor() : null}
      {activeTab === "version" ? renderVersionPanel() : null}
      {activeTab === "audit" ? renderAuditPanel() : null}
    </div>
  );
}
