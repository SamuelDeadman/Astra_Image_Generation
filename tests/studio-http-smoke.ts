import assert from "node:assert/strict";
import { baseTextToImageWorkflow } from "../src/lib/workflow/templates";

async function check(path: string, status: number, pattern: RegExp, init?: RequestInit) {
  const response = await fetch(`http://localhost:3100${path}`, init);
  const body = await response.text();
  assert.equal(response.status, status, `${path}: ${response.status}`);
  assert.match(body, pattern);
  console.log(`${path}: ${status}, expected response verified`);
}
async function main() {
  await check("/api/models", 503, /MONGODB_URI/);
  await check("/api/me", 401, /AUTHENTICATION_REQUIRED/);
  await check("/api/auth/config", 503, /NEXT_PUBLIC_GOOGLE_CLIENT_ID/);
  await check("/api/workflows/validate", 503, /MONGODB_URI/, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(baseTextToImageWorkflow) });
  await check("/api/workflows/validate", 422, /issues/, { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
  await check("/api/generations", 401, /AUTHENTICATION_REQUIRED/, { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
  await check("/api/auth/session", 503, /NEXT_PUBLIC_GOOGLE_CLIENT_ID/, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ credential: "test-only-invalid-credential" }) });
  await check("/ready", 503, /authentication.*NEXT_PUBLIC_GOOGLE_CLIENT_ID/);
  const page = await fetch("http://localhost:3100");
  assert.equal(page.status, 200);
  const csp = page.headers.get("content-security-policy")!;
  assert.match(csp, /connect-src[^;]*https:\/\/accounts.google.com\/gsi\//);
  assert.match(csp, /style-src[^;]*https:\/\/accounts.google.com\/gsi\/style/);
  assert.equal(page.headers.get("cross-origin-opener-policy"), "same-origin-allow-popups");
  assert.match(await page.text(), /Generate unavailable/);
  console.log("Studio page: 200, generation reason and Google security headers verified");
}
main().catch((error) => { console.error(error); process.exitCode = 1; });
