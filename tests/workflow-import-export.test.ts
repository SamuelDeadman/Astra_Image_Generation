import assert from "node:assert/strict";
import Module from "node:module";
import path from "node:path";
import test from "node:test";
import {
  addWorkflowEdge,
  addWorkflowNode,
  cloneWorkflowDocument,
  createDefaultWorkflowNode,
  removeDanglingWorkflowEdges,
  removeWorkflowNode
} from "../src/lib/workflow/graph";
import {
  approvedNodeTypes,
  defaultWorkflowExecutionEnvironment,
  normalizeWorkflowDocument,
  validateWorkflow,
  workflowLimits,
  workflowSchemaVersion,
  type ValidationModelContext,
  type ApprovedNodeType,
  type WorkflowDocument
} from "../src/lib/workflow/schema";
import {
  getExecutionEnvironmentSetupReasons,
  getWorkflowEnvironmentCompatibility,
  listCompatibleEnabledModels
} from "../src/lib/workflow/execution-environments";
import {
  createWorkflowExportPayload,
  parseWorkflowJsonText,
  stringifyWorkflowDocument
} from "../src/lib/workflow/serialization";
import { baseTextToImageWorkflow } from "../src/lib/workflow/templates";
import type { EnabledModelRecord } from "../src/server/models/models";

function workflowFixture(): WorkflowDocument {
  return cloneWorkflowDocument(baseTextToImageWorkflow);
}

function parseImport(input: unknown) {
  return parseWorkflowJsonText(JSON.stringify(input));
}

function expectImportRejected(input: unknown, expectedIssue: string) {
  const result = parseImport(input);

  assert.equal(result.ok, false);
  assert.match(result.ok ? "" : result.issues.join("\n"), new RegExp(expectedIssue, "i"));
}

function legacyWorkflowFixture() {
  return {
    schemaVersion: 1,
    selectedModel: "gcp-openweight-xl",
    nodes: [
      {
        id: "legacy_model",
        type: "model",
        position: { x: 580, y: 110 },
        data: { modelId: "gcp-openweight-xl" }
      },
      {
        id: "prompt",
        type: "positive-prompt",
        position: { x: 80, y: 60 },
        data: { prompt: "A precise editorial product photograph." }
      },
      {
        id: "negative",
        type: "negative-prompt",
        position: { x: 80, y: 190 },
        data: { prompt: "watermark" }
      },
      {
        id: "dimensions",
        type: "dimensions",
        position: { x: 320, y: 60 },
        data: { width: 768, height: 768, batch: 1 }
      },
      {
        id: "seed",
        type: "seed",
        position: { x: 320, y: 190 },
        data: { seed: 123, locked: true }
      },
      {
        id: "sampler",
        type: "sampler",
        position: { x: 580, y: 110 },
        data: { steps: 24, cfg: 6.5, sampler: "dpmpp-2m", scheduler: "karras" }
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
    edges: []
  };
}

type TestModelContext = ValidationModelContext & {
  availability?: "available" | "requires-credentials" | "development-only" | "not-configured";
};

function modelContext(route: ValidationModelContext["route"], overrides: Partial<TestModelContext> = {}): TestModelContext {
  return {
    id: overrides.id ?? "ollama-flux2-klein-4b-fp8",
    name: overrides.name ?? "FLUX.2 Klein 4B FP8",
    route,
    maxPixels: overrides.maxPixels ?? 1024 * 1024,
    maxSteps: overrides.maxSteps ?? 50,
    baseCreditCost: overrides.baseCreditCost ?? 4,
    isEnabled: overrides.isEnabled ?? true,
    capabilities: overrides.capabilities ?? ["text-to-image", "image-to-image"],
    ...overrides
  };
}

function enabledModel(route: EnabledModelRecord["route"], overrides: Partial<EnabledModelRecord> = {}): EnabledModelRecord {
  const now = new Date("2026-09-17T00:00:00Z");

  return {
    _id: overrides._id ?? "ollama-flux2-klein-4b-fp8",
    id: overrides.id ?? "ollama-flux2-klein-4b-fp8",
    providerId: overrides.providerId ?? "astraflow-ollama",
    pinnedVersion: overrides.pinnedVersion ?? "x/flux2-klein:4b-fp8",
    displayName: overrides.displayName ?? "FLUX.2 Klein 4B FP8",
    family: overrides.family ?? "Diffusion XL",
    route,
    licence: overrides.licence ?? "Open-weight checkpoint",
    licenceStatus: overrides.licenceStatus ?? "review-required",
    capabilities: overrides.capabilities ?? ["text-to-image", "image-to-image"],
    maxPixels: overrides.maxPixels ?? 1024 * 1024,
    maxSteps: overrides.maxSteps ?? 50,
    baseCreditCost: overrides.baseCreditCost ?? 4,
    isEnabled: overrides.isEnabled ?? true,
    createdAt: overrides.createdAt ?? now,
    updatedAt: overrides.updatedAt ?? now,
    provider: overrides.provider ?? {
      _id: "astraflow-ollama",
      id: "astraflow-ollama",
      name: "AstraFlow private Ollama",
      route,
      isEnabled: true,
      createdAt: now,
      updatedAt: now
    }
  };
}

async function loadServerCompiler() {
  const loader = Module as unknown as {
    _load(request: string, parent: unknown, isMain: boolean): unknown;
  };
  const originalLoad = loader._load;

  loader._load = function patchedLoad(request, parent, isMain) {
    if (request === "server-only") {
      return {};
    }

    if (request.startsWith("@/")) {
      return originalLoad.call(this, path.join(process.cwd(), "src", request.slice(2)), parent, isMain);
    }

    return originalLoad.call(this, request, parent, isMain);
  };

  try {
    return (await import("../src/server/workflows/compiler")) as typeof import("../src/server/workflows/compiler");
  } finally {
    loader._load = originalLoad;
  }
}

test("valid export round trip preserves graph contract and formatting", () => {
  const workflow = workflowFixture();
  const exported = createWorkflowExportPayload(workflow);

  assert.equal(exported.ok, true);
  assert.equal(exported.ok && exported.value.schemaVersion, workflowSchemaVersion);
  assert.equal(exported.ok && exported.value.executionEnvironment, "gcp-hosted");
  assert.deepEqual(exported.ok && exported.value.nodes, workflow.nodes);
  assert.deepEqual(exported.ok && exported.value.edges, workflow.edges);

  const serialized = stringifyWorkflowDocument(exported.ok ? exported.value : workflow);
  assert.equal(serialized.endsWith("\n"), true);

  const imported = parseWorkflowJsonText(serialized);
  assert.equal(imported.ok, true);
  assert.deepEqual(imported.ok && imported.value, exported.ok && exported.value);
});

test("export projection excludes non-portable identity, credentials, signed URLs, and binary extras", () => {
  const workflow = workflowFixture();
  const tainted = {
    ...workflow,
    id: "workflow_db_id",
    ownerId: "owner_db_id",
    revision: 7,
    currentVersion: { id: "revision_db_id" },
    nodes: workflow.nodes.map((node, index) =>
      index === 0
        ? {
            ...node,
            selected: true,
            data: {
              ...node.data,
              credentials: "secret",
              signedUrl: "https://storage.example/signed",
              assetBytes: "base64"
            }
          }
        : node
    ),
    edges: workflow.edges.map((edge) => ({ ...edge, selected: true }))
  };

  const exported = createWorkflowExportPayload(tainted);
  assert.equal(exported.ok, true);
  const serialized = JSON.stringify(exported.ok ? exported.value : {});

  for (const forbidden of [
    "workflow_db_id",
    "owner_db_id",
    "revision_db_id",
    "credentials",
    "signedUrl",
    "assetBytes",
    "\"selected\":"
  ]) {
    assert.equal(serialized.includes(forbidden), false, `${forbidden} leaked into export`);
  }
});

test("malformed, unsupported, and non-contract imports are rejected", () => {
  assert.equal(parseWorkflowJsonText("{").ok, false);
  expectImportRejected({ ...workflowFixture(), schemaVersion: 999 }, "unsupported workflow schema version");
  expectImportRejected({ ...workflowFixture(), ownerId: "owner_db_id" }, "unrecognized key");
});

test("legacy workflow JSON migrates through the shared normalization path", () => {
  const result = parseImport(legacyWorkflowFixture());

  assert.equal(result.ok, true);
  assert.equal(result.ok && result.value.schemaVersion, workflowSchemaVersion);
  assert.equal(result.ok && result.value.executionEnvironment, defaultWorkflowExecutionEnvironment);
  assert.equal(result.ok && result.value.nodes.some((node) => node.type === "text-to-image"), true);
  assert.equal(
    result.ok && result.notices.some((notice) => notice.includes("migrated from schema version 1")),
    true
  );
});

test("schema v2 workflow JSON migrates to a portable execution environment", () => {
  const v2Workflow = {
    ...workflowFixture(),
    schemaVersion: 2
  };
  delete (v2Workflow as Partial<WorkflowDocument>).executionEnvironment;

  const result = parseImport(v2Workflow);

  assert.equal(result.ok, true);
  assert.equal(result.ok && result.value.schemaVersion, workflowSchemaVersion);
  assert.equal(result.ok && result.value.executionEnvironment, "gcp-hosted");
  assert.equal(
    result.ok && result.notices.some((notice) => notice.includes("schema version 2")),
    true
  );
});

test("unsupported workflow execution environment is rejected", () => {
  expectImportRejected({ ...workflowFixture(), executionEnvironment: "arbitrary-url" }, "executionEnvironment|invalid");
});

test("development-local execution is rejected in production validation", () => {
  const workflow: WorkflowDocument = {
    ...workflowFixture(),
    selectedModel: "development-fake-model",
    executionEnvironment: "development-local",
    nodes: workflowFixture().nodes.map((node) =>
      node.type === "text-to-image"
        ? { ...node, data: { ...node.data, modelId: "development-fake-model", route: "development-fake" } }
        : node
    )
  };
  const result = validateWorkflow(workflow, {
    models: [modelContext("development-fake", { id: "development-fake-model", name: "Development Fake Adapter" })],
    nodeEnv: "production"
  });

  assert.equal(result.ok, false);
  assert.match(result.ok ? "" : result.issues.join("\n"), /development-local/i);
});

test("workflow environment policy accepts compatible models and rejects incompatible routes", () => {
  const workflow = workflowFixture();
  const gcpModel = modelContext("gcp-hosted-gpu");
  const aiStudioModel = modelContext("google-ai-studio-image", { name: "Google AI Studio Image" });

  assert.equal(validateWorkflow(workflow, { models: [gcpModel] }).ok, true);
  assert.equal(getWorkflowEnvironmentCompatibility(workflow, [gcpModel]).ok, true);

  const incompatible = validateWorkflow(workflow, { models: [aiStudioModel] });
  assert.equal(incompatible.ok, false);
  assert.match(incompatible.ok ? "" : incompatible.issues.join("\n"), /execution environment gcp-hosted/i);
});

test("environment helpers report no compatible model and credential setup states", () => {
  const models = [
    modelContext("google-ai-studio-image", {
      id: "google-ai-studio-image",
      name: "Google AI Studio Image",
      availability: "requires-credentials"
    })
  ];

  assert.equal(listCompatibleEnabledModels(models, "gcp-hosted").length, 0);
  assert.deepEqual(getExecutionEnvironmentSetupReasons({ environment: "gcp-hosted", models }), [
    "No enabled model is registered for GCP hosted worker."
  ]);
  assert.deepEqual(getExecutionEnvironmentSetupReasons({ environment: "google-ai-studio", models, hasCredential: false }), [
    "A provider credential or server-side API key is required before generation."
  ]);
});

test("node route hints cannot override authoritative model routes", () => {
  const workflow: WorkflowDocument = {
    ...workflowFixture(),
    nodes: workflowFixture().nodes.map((node) =>
      node.type === "text-to-image" ? { ...node, data: { ...node.data, route: "external-byok" } } : node
    )
  };
  const result = validateWorkflow(workflow, {
    models: [modelContext("gcp-hosted-gpu")]
  });

  assert.equal(result.ok, false);
  assert.match(result.ok ? "" : result.issues.join("\n"), /does not match authorised model route/i);
});

test("execution plan records deterministic environment and route summaries", async () => {
  const workflow = workflowFixture();
  const { compileWorkflowExecutionPlan } = await loadServerCompiler();
  const plan = compileWorkflowExecutionPlan({
    ownerId: "owner_123",
    workflowId: "workflow_123",
    workflowRevisionId: "revision_123",
    workflow,
    models: [enabledModel("gcp-hosted-gpu")]
  });

  assert.equal(plan.executionEnvironment, "gcp-hosted");
  assert.deepEqual(plan.modelIds, ["ollama-flux2-klein-4b-fp8"]);
  assert.deepEqual(plan.routeSummary, ["gcp-hosted-gpu", "output-router", "safety-moderation"]);
  assert.equal(plan.steps.find((step) => step.nodeId === "image_model")?.adapterId, "gcp-hosted-gpu");
});

test("invalid imports report node data, type, duplicate id, edge, port, cycle, and limit failures", () => {
  const invalidPrompt = workflowFixture();
  invalidPrompt.nodes = invalidPrompt.nodes.map((node) =>
    node.type === "prompt-input" ? { ...node, data: { prompt: "" } } : node
  );
  expectImportRejected(invalidPrompt, "too small|string");

  const unknownBase = workflowFixture();
  const unknownNode: unknown = {
    ...unknownBase,
    nodes: [{ ...unknownBase.nodes[0], type: "unknown-node" }, ...unknownBase.nodes.slice(1)]
  };
  expectImportRejected(unknownNode, "invalid discriminator|invalid input");

  const duplicateNode = workflowFixture();
  duplicateNode.nodes = duplicateNode.nodes.map((node, index) => (index === 1 ? { ...node, id: duplicateNode.nodes[0].id } : node));
  expectImportRejected(duplicateNode, "duplicate node id");

  const danglingEdge = workflowFixture();
  danglingEdge.edges = [{ ...danglingEdge.edges[0], id: "e-dangling", target: "missing-node" }];
  expectImportRejected(danglingEdge, "missing node");

  const invalidPort = workflowFixture();
  invalidPort.edges = [{ ...invalidPort.edges[0], id: "e-invalid-port", sourceHandle: "missing-port" }];
  expectImportRejected(invalidPort, "invalid source handle");

  const incompatiblePort = workflowFixture();
  incompatiblePort.edges = [
    ...incompatiblePort.edges,
    {
      id: "e-incompatible",
      source: "prompt",
      sourceHandle: "text",
      target: "image_model",
      targetHandle: "dimensions"
    }
  ];
  expectImportRejected(incompatiblePort, "connects text output to dimensions input");

  const cycle = workflowFixture();
  cycle.edges = [
    ...cycle.edges,
    {
      id: "e-cycle",
      source: "safety",
      sourceHandle: "safety",
      target: "image_model",
      targetHandle: "metadata"
    }
  ];
  expectImportRejected(cycle, "cycle");

  const tooLarge = workflowFixture();
  tooLarge.nodes = Array.from({ length: workflowLimits.maxNodes + 1 }, (_, index) => ({
    id: `prompt_${index}`,
    type: "prompt-input" as const,
    position: { x: index * 10, y: 0 },
    data: { prompt: `Prompt ${index}` }
  }));
  tooLarge.edges = [];
  expectImportRejected(tooLarge, "at most|maximum");
});

test("failed import leaves the existing workflow object untouched", () => {
  const current = workflowFixture();
  const before = JSON.stringify(current);
  const result = parseWorkflowJsonText("{not json");

  assert.equal(result.ok, false);
  assert.equal(JSON.stringify(current), before);
});

test("repeated add operations create unique ids and respect maxNodes", () => {
  let workflow = workflowFixture();
  const addedIds: string[] = [];

  for (let index = workflow.nodes.length; index < workflowLimits.maxNodes; index += 1) {
    const result = addWorkflowNode(workflow, "prompt-input");
    assert.equal(result.ok, true);
    workflow = result.ok ? result.value.workflow : workflow;
    addedIds.push(result.ok ? result.value.node.id : "");
  }

  assert.equal(new Set([...workflow.nodes.map((node) => node.id)]).size, workflow.nodes.length);
  assert.equal(addedIds.includes("prompt_input"), true);
  assert.equal(addedIds.includes("prompt_input_2"), true);

  const overflow = addWorkflowNode(workflow, "prompt-input");
  assert.equal(overflow.ok, false);
  assert.match(overflow.ok ? "" : overflow.issues.join("\n"), /maximum of 40 nodes/i);
});

function connectDefaultNode(workflow: WorkflowDocument, nodeId: string, type: ApprovedNodeType) {
  let next = workflow;
  const edgesByType: Partial<Record<ApprovedNodeType, Parameters<typeof addWorkflowEdge>[1][]>> = {
    "text-to-image": [{ source: "prompt", sourceHandle: "text", target: nodeId, targetHandle: "prompt" }],
    "image-to-image": [
      { source: "prompt", sourceHandle: "text", target: nodeId, targetHandle: "prompt" },
      { source: "image_model", sourceHandle: "image", target: nodeId, targetHandle: "image" }
    ],
    "image-analysis": [{ source: "image_model", sourceHandle: "image", target: nodeId, targetHandle: "image" }],
    "safety-check": [{ source: "image_model", sourceHandle: "image", target: nodeId, targetHandle: "image" }],
    "image-transform": [{ source: "image_model", sourceHandle: "image", target: nodeId, targetHandle: "image" }],
    output: [{ source: "image_model", sourceHandle: "image", target: nodeId, targetHandle: "image" }]
  };

  for (const edge of edgesByType[type] ?? []) {
    const result = addWorkflowEdge(next, edge);
    assert.equal(result.ok, true, result.ok ? "" : result.issues.join("\n"));
    next = result.ok ? result.value.workflow : next;
  }

  return next;
}

test("every approved node type has defaults that can participate in a valid normalized graph", () => {
  for (const type of approvedNodeTypes) {
    const nodeResult = createDefaultWorkflowNode(type, workflowFixture());
    assert.equal(nodeResult.ok, true, `${type} default was not created`);

    const addResult = addWorkflowNode(workflowFixture(), type);
    assert.equal(addResult.ok, true, `${type} could not be added`);

    const workflow = addResult.ok
      ? connectDefaultNode(addResult.value.workflow, addResult.value.node.id, type)
      : workflowFixture();
    const exportResult = createWorkflowExportPayload(workflow);
    assert.equal(exportResult.ok, true, `${type} default did not normalize: ${exportResult.ok ? "" : exportResult.issues.join("; ")}`);
  }
});

test("removing a node removes incident edges and returns deterministic selection", () => {
  const workflow = workflowFixture();
  const result = removeWorkflowNode(workflow, "image_model", { selectedNodeId: "image_model" });

  assert.equal(result.ok, true);
  assert.equal(result.ok && result.value.selectedNodeId, "prompt");
  assert.equal(result.ok && result.value.workflow.nodes.some((node) => node.id === "image_model"), false);
  assert.equal(
    result.ok && result.value.workflow.edges.some((edge) => edge.source === "image_model" || edge.target === "image_model"),
    false
  );
  assert.deepEqual(result.ok && result.value.removedEdgeIds.sort(), [
    "e-dimensions-image",
    "e-image-safety",
        "e-prompt-image",
      ]);
});

test("dangling edge cleanup is explicit and immutable", () => {
  const workflow = workflowFixture();
  const withDangling: WorkflowDocument = {
    ...workflow,
    edges: [...workflow.edges, { id: "e-dangling", source: "missing", sourceHandle: "image", target: "output", targetHandle: "image" }]
  };
  const result = removeDanglingWorkflowEdges(withDangling);

  assert.equal(result.ok, true);
  assert.deepEqual(result.ok && result.value.removedEdgeIds, ["e-dangling"]);
  assert.equal(withDangling.edges.some((edge) => edge.id === "e-dangling"), true);
  assert.equal(result.ok && result.value.workflow.edges.some((edge) => edge.id === "e-dangling"), false);
});

test("client serialization and server normalization agree on the accepted portable contract", () => {
  const exported = createWorkflowExportPayload(workflowFixture());
  assert.equal(exported.ok, true);

  const imported = parseWorkflowJsonText(stringifyWorkflowDocument(exported.ok ? exported.value : workflowFixture()));
  assert.equal(imported.ok, true);

  const normalized = normalizeWorkflowDocument(imported.ok ? imported.value : {});
  const validated = validateWorkflow(imported.ok ? imported.value : {});

  assert.equal(normalized.ok, true);
  assert.equal(validated.ok, true);
  assert.deepEqual(normalized.ok && normalized.workflow, validated.ok && validated.workflow);
});
