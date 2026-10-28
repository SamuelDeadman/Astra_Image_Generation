import { getModelById, type ModelDefinition } from "./catalog";
import type { WorkflowDocument, WorkflowNode } from "../workflow/schema";

export type ModelConstraintIssue = { nodeId: string; field: string; value: unknown; constraint: string; message: string };
function issue(nodeId: string, field: string, value: unknown, constraint: string): ModelConstraintIssue {
  return { nodeId, field, value, constraint, message: `${nodeId}: ${field} = ${String(value)}. ${constraint}` };
}
export function effectiveImageValues(workflow: WorkflowDocument, node: WorkflowNode) {
  const result = { ...node.data } as Record<string, unknown>;
  const edge = workflow.edges.find((entry) => entry.target === node.id && entry.targetHandle === "dimensions");
  const dimensions = edge && workflow.nodes.find((entry) => entry.id === edge.source && entry.type === "dimensions");
  if (dimensions?.type === "dimensions") Object.assign(result, dimensions.data);
  return result;
}
export function nodeModelConstraintIssues(workflow: WorkflowDocument, node: WorkflowNode, model = "modelId" in node.data ? getModelById(node.data.modelId ?? "") : undefined): ModelConstraintIssue[] {
  if (!model || !["text-to-image", "image-to-image"].includes(node.type)) return [];
  const values = effectiveImageValues(workflow, node);
  const issues: ModelConstraintIssue[] = [];
  const dimensionEdge = workflow.edges.find((entry) => entry.target === node.id && entry.targetHandle === "dimensions");
  const dimensionsOwner = dimensionEdge?.source ?? node.id;
  if (dimensionEdge && model.resolutions.length) {
    const inline = node.data as Record<string, unknown>;
    if (!model.resolutions.some((size) => size.width === inline.width && size.height === inline.height)) issues.push(issue(node.id, "resolution", `${inline.width} × ${inline.height}`, "Inline dimensions must also match a supported model resolution, even with a dimensions connection. Review node auto-fill."));
  }
  for (const [field, bounds] of Object.entries(model.numericBounds ?? {})) {
    const value = values[field];
    if (value === undefined) continue;
    if (typeof value !== "number" || value < bounds.min || value > bounds.max || Math.abs((value - bounds.min) / bounds.step - Math.round((value - bounds.min) / bounds.step)) > 1e-6) issues.push(issue(["width", "height", "batch"].includes(field) ? dimensionsOwner : node.id, field, value, `${model.name} requires ${bounds.min}–${bounds.max}, increments of ${bounds.step}.`));
  }
  if (model.resolutions.length && !model.resolutions.some((size) => size.width === values.width && size.height === values.height)) issues.push(issue(dimensionsOwner, "resolution", `${values.width} × ${values.height}`, `${model.name} supports these AstraFlow resolutions: ${model.resolutions.map((size) => `${size.width} × ${size.height}`).join(", ")}.`));
  if (!model.developmentOnly && values.batch !== 1) issues.push(issue(dimensionsOwner, "batch", values.batch, "This adapter supports exactly 1 image per node; batch generation is unavailable."));
  for (const field of model.unsupportedParameters) if (values[field] !== undefined) issues.push(issue(node.id, field, values[field], `${model.name} does not expose ${field}; remove it using confirmed model auto-fill.`));
  if (!model.outputFormats.includes(String(values.outputFormat))) issues.push(issue(node.id, "outputFormat", values.outputFormat, `Supported output formats: ${model.outputFormats.join(", ")}.`));
  const negativeEdge = workflow.edges.find((entry) => entry.target === node.id && entry.targetHandle === "negative");
  const negativeNode = negativeEdge && workflow.nodes.find((entry) => entry.id === negativeEdge.source);
  if (!model.negativePromptSupported && (values.negativePrompt || (negativeNode?.type === "negative-prompt" && negativeNode.data.prompt.trim()))) issues.push(issue(negativeNode?.id ?? node.id, "negativePrompt", negativeNode?.type === "negative-prompt" ? negativeNode.data.prompt : values.negativePrompt, "Dedicated negative prompting is unsupported. Express exclusions in the positive prompt or remove this value explicitly."));
  const seedEdge = workflow.edges.find((entry) => entry.target === node.id && entry.targetHandle === "seed");
  if (!model.developmentOnly && seedEdge) issues.push(issue(seedEdge.source, "seed connection", "connected", "This provider does not expose deterministic seeds. Remove this connection explicitly."));
  return issues;
}
export function workflowModelConstraintIssues(workflow: WorkflowDocument) { return workflow.nodes.flatMap((node) => nodeModelConstraintIssues(workflow, node)); }

export type DefaultsChange = { nodeId: string; field: string; before: unknown; after: unknown };
export type DefaultsPreview = { source: string; changes: DefaultsChange[]; skipped: string[] };
export function previewModelDefaults(workflow: WorkflowDocument, model: ModelDefinition, nodeId?: string): DefaultsPreview {
  const changes: DefaultsChange[] = [];
  const skipped: string[] = [];
  const add = (node: WorkflowNode, field: string, after: unknown) => {
    const before = (node.data as Record<string, unknown>)[field];
    if (before !== after && !changes.some((change) => change.nodeId === node.id && change.field === field)) changes.push({ nodeId: node.id, field, before, after });
  };
  const targets = workflow.nodes.filter((node) => (!nodeId || node.id === nodeId) && ["text-to-image", "image-to-image"].includes(node.type));
  for (const node of targets) {
    if (!model.capabilities.includes(node.type)) { skipped.push(`${node.id}: ${model.name} cannot run ${node.type}.`); continue; }
    add(node, "modelId", model.id); add(node, "route", model.route);
    for (const [field, value] of Object.entries(model.defaults)) if (field !== "strength" || node.type === "image-to-image") add(node, field, value);
    for (const field of model.unsupportedParameters) add(node, field, undefined);
    const dimensionsEdge = workflow.edges.find((edge) => edge.target === node.id && edge.targetHandle === "dimensions");
    const dimensions = dimensionsEdge && workflow.nodes.find((entry) => entry.id === dimensionsEdge.source);
    if (dimensions?.type === "dimensions") {
      const otherConsumers = workflow.edges.filter((edge) => edge.source === dimensions.id && edge.target !== node.id);
      if (nodeId && otherConsumers.length) skipped.push(`${dimensions.id} is shared with ${otherConsumers.map((edge) => edge.target).join(", ")}; its values are retained. Edit it explicitly.`);
      else for (const field of ["width", "height", "batch"]) add(dimensions, field, model.defaults[field]);
    }
  }
  return { source: JSON.stringify(workflow), changes, skipped };
}
export function applyConfirmedModelDefaults(workflow: WorkflowDocument, preview: DefaultsPreview, confirmed: boolean): WorkflowDocument {
  if (!confirmed || JSON.stringify(workflow) !== preview.source) return workflow;
  const nodes = workflow.nodes.map((node) => {
    const data = { ...node.data } as Record<string, unknown>;
    for (const change of preview.changes.filter((entry) => entry.nodeId === node.id)) { if (change.after === undefined) delete data[change.field]; else data[change.field] = change.after; }
    return { ...node, data } as WorkflowNode;
  });
  return { ...workflow, nodes };
}
