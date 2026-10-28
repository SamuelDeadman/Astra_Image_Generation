import type { Node, NodeChange } from "@xyflow/react";
import type { WorkflowDocument, WorkflowNode } from "@/lib/workflow/schema";

export type StudioNodeData = {
  label: string;
  eyebrow: string;
  body: string;
  connectedInputs?: string[];
  connectedOutputs?: string[];
};
export type StudioFlowNode = Node<StudioNodeData>;

function sameHandles(left: string[] = [], right: string[] = []) {
  return left.length === right.length && left.every((handle, index) => handle === right[index]);
}

function sameData(left: StudioNodeData, right: StudioNodeData) {
  return left.label === right.label && left.eyebrow === right.eyebrow && left.body === right.body &&
    sameHandles(left.connectedInputs, right.connectedInputs) && sameHandles(left.connectedOutputs, right.connectedOutputs);
}

// Workflow documents contain durable graph data. React Flow owns measurements,
// selection and live dragging; never discard that state when synchronizing edits.
export function reconcileCanvasNodes(current: StudioFlowNode[], incoming: StudioFlowNode[]): StudioFlowNode[] {
  const byId = new Map(current.map((node) => [node.id, node]));
  const selectNewNode = incoming.some((node) => node.selected && !byId.has(node.id));
  const next = incoming.map((node) => {
    const previous = byId.get(node.id);
    if (!previous || previous.type !== node.type) return node;
    const position = previous.dragging ? previous.position : node.position;
    const samePosition = previous.position.x === position.x && previous.position.y === position.y;
    const dataUnchanged = sameData(previous.data, node.data);
    const selected = selectNewNode ? Boolean(node.selected) : previous.selected;
    if (samePosition && dataUnchanged && selected === previous.selected) return previous;
    return {
      ...previous,
      ...node,
      position: samePosition ? previous.position : { ...position },
      data: dataUnchanged ? previous.data : node.data,
      selected,
      measured: previous.measured
    };
  });
  return next.length === current.length && next.every((node, index) => node === current[index]) ? current : next;
}

export function commitCanvasPositions(workflow: WorkflowDocument, changes: NodeChange<StudioFlowNode>[]): WorkflowDocument {
  const positions = new Map<string, WorkflowNode["position"]>();
  for (const change of changes) {
    if (change.type === "position" && change.dragging !== true && change.position &&
        Number.isFinite(change.position.x) && Number.isFinite(change.position.y)) {
      positions.set(change.id, change.position);
    }
  }
  if (!positions.size) return workflow;
  let changed = false;
  const nodes = workflow.nodes.map((node) => {
    const position = positions.get(node.id);
    if (!position || (node.position.x === position.x && node.position.y === position.y)) return node;
    changed = true;
    // Copy coordinates only: dragging, measurements and DOM data never enter saved workflows.
    return { ...node, position: { x: position.x, y: position.y } };
  });
  return changed ? { ...workflow, nodes } : workflow;
}
