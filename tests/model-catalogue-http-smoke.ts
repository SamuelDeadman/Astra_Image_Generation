import assert from "node:assert/strict";
import { baseTextToImageWorkflow } from "../src/lib/workflow/templates";

async function main() {
  const origin = process.env.CATALOGUE_SMOKE_ORIGIN ?? "http://localhost:3100";
  const response = await fetch(`${origin}/api/models`);
  assert.equal(response.status, 200);
  const { models } = await response.json();
  assert.deepEqual(models.map((model: { id: string }) => model.id).sort(), ["google-ai-studio-image", "vertex-gemini-image"]);
  assert(models.every((model: { isEnabled: boolean; availability: string; generationUnavailableReason?: string }) => !model.isEnabled && model.availability === "unavailable" && model.generationUnavailableReason?.includes("live")));
  assert(models.every((model: { definition?: { sources?: string[] } }) => model.definition?.sources?.length));
  console.log("Production catalogue API: concrete candidates only, unverified entries unavailable, development excluded.");
  const invalid = structuredClone(baseTextToImageWorkflow);
  const dimensions = invalid.nodes.find((node) => node.type === "dimensions");
  assert(dimensions?.type === "dimensions"); dimensions.data.width = 1500;
  const validation = await fetch(`${origin}/api/workflows/validate`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(invalid) });
  assert.equal(validation.status, 422);
  const issues = await validation.json(); assert(issues.issues.some((issue: string) => issue.includes("1500")));
  console.log("Server validation: unsupported resolution rejected with affected value and constraint.");
  const admission = await fetch(`${origin}/api/generations`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ workflow: baseTextToImageWorkflow, idempotencyKey: "test-only-http-smoke" }) });
  assert.equal(admission.status, 401);
  const page = await fetch(origin); assert.equal(page.status, 200);
  assert.match(await page.text(), /Apply selected model defaults/);
  console.log("Production page: model-default action rendered; unsigned admission rejected.");
}
main().catch((error) => { console.error(error instanceof Error ? error.message : "HTTP smoke failed."); process.exitCode = 1; });
