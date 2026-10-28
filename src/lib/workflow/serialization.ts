import {
  normalizeWorkflowDocument,
  validateWorkflow,
  workflowSchemaVersion,
  type WorkflowDocument,
  type WorkflowEdge,
  type WorkflowNode
} from "./schema";
import { isApprovedWorkflowNodeType } from "./graph";
import { getWorkflowNodeDefinition } from "./registry";

export const maxWorkflowImportBytes = 512 * 1024;

export type WorkflowSerializationResult<T> =
  | {
      ok: true;
      value: T;
      notices: string[];
    }
  | {
      ok: false;
      issues: string[];
    };

type JsonRecord = Record<string, unknown>;

function isRecord(value: unknown): value is JsonRecord {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function jsonClone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function pickDefined(source: JsonRecord, keys: readonly string[]) {
  const result: JsonRecord = {};

  for (const key of keys) {
    if (typeof source[key] !== "undefined") {
      result[key] = jsonClone(source[key]);
    }
  }

  return result;
}

function projectStoragePolicy(value: unknown) {
  return isRecord(value) ? pickDefined(value, ["visibility", "retainIntermediate"]) : value;
}

function projectExecutionPolicy(value: unknown) {
  if (!isRecord(value)) {
    return value;
  }

  const projected: JsonRecord = pickDefined(value, ["timeoutSeconds", "optional"]);

  if (typeof value.retryPolicy !== "undefined") {
    projected.retryPolicy = isRecord(value.retryPolicy)
      ? pickDefined(value.retryPolicy, ["maxAttempts", "backoffSeconds", "retryable"])
      : value.retryPolicy;
  }

  return projected;
}

function projectNodeData(node: JsonRecord) {
  const type = typeof node.type === "string" ? node.type : "";
  const data = isRecord(node.data) ? node.data : node.data;

  if (!isApprovedWorkflowNodeType(type) || !isRecord(data)) {
    return jsonClone(data);
  }

  const projected = pickDefined(data, getWorkflowNodeDefinition(type).contractDataKeys);

  if ("storagePolicy" in projected) {
    projected.storagePolicy = projectStoragePolicy(projected.storagePolicy);
  }

  return projected;
}

function projectWorkflowNode(node: unknown): unknown {
  if (!isRecord(node)) {
    return node;
  }

  const projected: JsonRecord = pickDefined(node, ["id", "type", "position", "label"]);

  if (typeof node.execution !== "undefined") {
    projected.execution = projectExecutionPolicy(node.execution);
  }

  projected.data = projectNodeData(node);

  return projected;
}

function projectWorkflowEdge(edge: unknown): unknown {
  return isRecord(edge) ? pickDefined(edge, ["id", "source", "sourceHandle", "target", "targetHandle"]) : edge;
}

export function projectWorkflowForExport(input: unknown): unknown {
  if (!isRecord(input)) {
    return input;
  }

  return {
    schemaVersion: input.schemaVersion,
    ...(typeof input.selectedModel !== "undefined" ? { selectedModel: input.selectedModel } : {}),
    ...(typeof input.executionEnvironment !== "undefined" ? { executionEnvironment: input.executionEnvironment } : {}),
    nodes: Array.isArray(input.nodes) ? input.nodes.map(projectWorkflowNode) : input.nodes,
    edges: Array.isArray(input.edges) ? input.edges.map(projectWorkflowEdge) : input.edges
  };
}

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value);
  }

  if (Array.isArray(value)) {
    return `[${value.map((entry) => stableStringify(entry)).join(",")}]`;
  }

  return `{${Object.entries(value as JsonRecord)
    .filter(([, entry]) => typeof entry !== "undefined")
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, entry]) => `${JSON.stringify(key)}:${stableStringify(entry)}`)
    .join(",")}}`;
}

export function createWorkflowExportPayload(input: unknown): WorkflowSerializationResult<WorkflowDocument> {
  const projected = projectWorkflowForExport(input);
  const validation = validateWorkflow(projected);

  if (!validation.ok) {
    return {
      ok: false,
      issues: validation.issues
    };
  }

  return {
    ok: true,
    value: projectWorkflowForExport(validation.workflow) as WorkflowDocument,
    notices: validation.warnings
  };
}

export function stringifyWorkflowDocument(workflow: WorkflowDocument) {
  return `${JSON.stringify(workflow, null, 2)}\n`;
}

export function sanitizeWorkflowFilename(name: string) {
  const safeName = name
    .trim()
    .replace(/[<>:"/\\|?*\u0000-\u001f]+/g, "-")
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);

  return `${safeName || "workflow"}.json`;
}

function parsedSchemaVersion(value: unknown) {
  return isRecord(value) && typeof value.schemaVersion === "number" ? value.schemaVersion : null;
}

export function parseWorkflowJsonText(text: string): WorkflowSerializationResult<WorkflowDocument> {
  if (new TextEncoder().encode(text).byteLength > maxWorkflowImportBytes) {
    return {
      ok: false,
      issues: [`Workflow file exceeds the ${Math.round(maxWorkflowImportBytes / 1024)} KB import limit.`]
    };
  }

  let parsed: unknown;

  try {
    parsed = JSON.parse(text);
  } catch {
    return {
      ok: false,
      issues: ["Workflow JSON is malformed and could not be parsed."]
    };
  }

  const version = parsedSchemaVersion(parsed);

  if (version !== null && version !== 1 && version !== 2 && version !== workflowSchemaVersion) {
    return {
      ok: false,
      issues: [`Unsupported workflow schema version ${version}. Supported versions are 1, 2, and ${workflowSchemaVersion}.`]
    };
  }

  const normalized = normalizeWorkflowDocument(parsed);

  if (!normalized.ok) {
    return {
      ok: false,
      issues: normalized.issues
    };
  }

  const exportable = createWorkflowExportPayload(normalized.workflow);

  if (!exportable.ok) {
    return exportable;
  }

  const notices = [...normalized.warnings, ...exportable.notices].filter(
    (notice, index, values) => values.indexOf(notice) === index
  );

  if (
    version === workflowSchemaVersion &&
    stableStringify(projectWorkflowForExport(parsed)) !== stableStringify(exportable.value)
  ) {
    notices.push("Workflow was normalized with supported defaults before import.");
  }

  return {
    ok: true,
    value: exportable.value,
    notices
  };
}

export function workflowContainsPortableGraphOnly(workflow: WorkflowDocument) {
  const projected = projectWorkflowForExport(workflow);
  return stableStringify(projected) === stableStringify(workflow);
}

export type PortableWorkflowNode = WorkflowNode;
export type PortableWorkflowEdge = WorkflowEdge;
