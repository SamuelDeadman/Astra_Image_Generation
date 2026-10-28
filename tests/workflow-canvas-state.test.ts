import assert from "node:assert/strict";
import test from "node:test";
import { applyNodeChanges } from "@xyflow/react";
import { commitCanvasPositions, reconcileCanvasNodes, type StudioFlowNode } from "../src/components/studio/workflow-canvas-state";
import { baseTextToImageWorkflow } from "../src/lib/workflow/templates";
import { stringifyWorkflowDocument } from "../src/lib/workflow/serialization";

function node(id = "prompt"): StudioFlowNode {
  return { id, type: "prompt-input", position: { x: 80, y: 60 }, data: { label: "Prompt", eyebrow: "Text", body: "A ceramic cup", connectedInputs: [], connectedOutputs: ["text"] } };
}

test("measured nodes and handles survive selection, dragging, release and workflow acknowledgement", () => {
  let live = applyNodeChanges([
    { id: "prompt", type: "dimensions", dimensions: { width: 232, height: 195 } },
    { id: "prompt", type: "select", selected: true }
  ], [node()]);
  const data = live[0].data;
  for (let frame = 1; frame <= 60; frame++) {
    live = applyNodeChanges([{ id: "prompt", type: "position", position: { x: 80 + frame, y: 60 + frame }, dragging: true }], live);
    assert.deepEqual(live[0].measured, { width: 232, height: 195 });
    // A model/status refresh with old durable coordinates must not interrupt a drag.
    assert.equal(reconcileCanvasNodes(live, [node()]), live);
  }
  live = applyNodeChanges([{ id: "prompt", type: "position", position: { x: 140, y: 120 }, dragging: false }], live);
  const committed = { ...node(), position: { x: 140, y: 120 } };
  assert.equal(reconcileCanvasNodes(live, [committed]), live);
  assert.equal(live[0].selected, true);
  assert.equal(live[0].data, data);
  assert.deepEqual(live[0].measured, { width: 232, height: 195 });
});

test("live frames never rewrite the workflow, and the exact drop coordinates persist once", () => {
  const workflow = structuredClone(baseTextToImageWorkflow);
  for (let frame = 1; frame <= 60; frame++) {
    assert.equal(commitCanvasPositions(workflow, [{ id: "prompt", type: "position", position: { x: frame, y: frame }, dragging: true }]), workflow);
  }
  const changes = [{ id: "prompt", type: "position" as const, position: { x: 193.375, y: -12.25 }, dragging: false }];
  const committed = commitCanvasPositions(workflow, changes);
  assert.notEqual(committed, workflow);
  assert.deepEqual(committed.nodes[0].position, changes[0].position);
  assert.notEqual(committed.nodes[0].position, changes[0].position);
  assert.equal(committed.nodes[1], workflow.nodes[1]);
  assert.equal(commitCanvasPositions(committed, changes), committed);
  assert.doesNotMatch(stringifyWorkflowDocument(committed), /"measured"|"dragging"|"selected"/);
});

test("multi-node drops and keyboard moves commit all changed positions in one graph update", () => {
  const workflow = structuredClone(baseTextToImageWorkflow);
  const moved = commitCanvasPositions(workflow, [
    { id: "prompt", type: "position", position: { x: 240, y: 180 }, dragging: false },
    { id: "dimensions", type: "position", position: { x: 480, y: 180 }, dragging: false }
  ]);
  assert.deepEqual(moved.nodes.slice(0, 2).map((entry) => entry.position), [{ x: 240, y: 180 }, { x: 480, y: 180 }]);
  const keyboard = commitCanvasPositions(moved, [{ id: "prompt", type: "position", position: { x: 245, y: 180 } }]);
  assert.equal(keyboard.nodes[0].position.x, 245);
});

test("non-position updates, removed IDs and invalid coordinates cannot corrupt saved layouts", () => {
  const workflow = structuredClone(baseTextToImageWorkflow);
  assert.equal(commitCanvasPositions(workflow, [
    { id: "prompt", type: "dimensions", dimensions: { width: 232, height: 200 } },
    { id: "prompt", type: "select", selected: true },
    { id: "removed", type: "position", position: { x: 20, y: 20 }, dragging: false },
    { id: "prompt", type: "position", position: { x: NaN, y: Infinity }, dragging: false }
  ]), workflow);
});

test("inspector, model and connection edits update only the affected node without losing measurements", () => {
  const first = { ...node(), measured: { width: 232, height: 195 }, selected: true };
  const second = node("dimensions");
  const current = [first, second];
  const incoming = [{ ...node(), data: { ...node().data, body: "Edited prompt", connectedOutputs: [] } }, node("dimensions")];
  const next = reconcileCanvasNodes(current, incoming);
  assert.notEqual(next[0], first);
  assert.equal(next[0].data.body, "Edited prompt");
  assert.deepEqual(next[0].data.connectedOutputs, []);
  assert.equal(next[0].measured, first.measured);
  assert.equal(next[0].selected, true);
  assert.equal(next[1], second);
});

test("graph replacement, removals and node-type changes use authoritative data", () => {
  const current = [{ ...node(), measured: { width: 232, height: 195 } }, node("removed")];
  const replacement = [{ ...node(), position: { x: 800, y: 400 } }, node("added")];
  const next = reconcileCanvasNodes(current, replacement);
  assert.deepEqual(next.map((entry) => entry.id), ["prompt", "added"]);
  assert.deepEqual(next[0].position, replacement[0].position);
  const changedType = { ...node(), type: "image-to-image" };
  assert.equal(reconcileCanvasNodes(current, [changedType])[0], changedType);
  assert.equal(reconcileCanvasNodes(current, [changedType])[0].measured, undefined);
});

test("adding a focused node selects it without destroying existing node measurements", () => {
  const first = { ...node(), selected: true, measured: { width: 232, height: 195 } };
  const added = { ...node("added"), selected: true };
  const next = reconcileCanvasNodes([first], [{ ...node(), selected: false }, added]);
  assert.equal(next[0].selected, false);
  assert.equal(next[0].measured, first.measured);
  assert.equal(next[1].selected, true);
});
