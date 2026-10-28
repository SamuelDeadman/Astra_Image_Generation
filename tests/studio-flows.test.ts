import assert from "node:assert/strict";
import Module from "node:module";
import path from "node:path";
import test from "node:test";
import { MongoNetworkError, MongoParseError, MongoServerError } from "mongodb";
import { googleConfigurationIssue } from "../src/lib/auth/configuration";
import { loadGoogleScript } from "../src/lib/auth/google-script";
import { apiErrorMessage } from "../src/lib/http/client";
import { baseTextToImageWorkflow } from "../src/lib/workflow/templates";

const testRequire = Module.createRequire(path.join(process.cwd(), "tests", "studio-flows.test.ts"));

function load<T>(file: string, mocks: Record<string, unknown> = {}): T {
  const loader = Module as unknown as { _load(request: string, parent: unknown, isMain: boolean): unknown };
  const original = loader._load;
  loader._load = function(request, parent, isMain) {
    if (request in mocks) return mocks[request];
    if (request === "server-only") return {};
    return original.call(this, request.startsWith("@/") ? path.join(process.cwd(), "src", request.slice(2)) : request, parent, isMain);
  };
  try {
    const resolved = testRequire.resolve(path.join(process.cwd(), file));
    delete testRequire.cache[resolved];
    return testRequire(resolved) as T;
  } finally { loader._load = original; }
}

const errors = load<typeof import("../src/server/errors")>("src/server/errors.ts");
const { generationSetupIssue } = load<typeof import("../src/server/generations/readiness")>("src/server/generations/readiness.ts");
const http = load<typeof import("../src/server/http")>("src/server/http.ts");
const enabledModel = { id: "ollama-flux2-klein-4b-fp8", name: "FLUX.2 Klein 4B FP8", route: "gcp-hosted-gpu", maxPixels: 1024 * 1024, maxSteps: 50, baseCreditCost: 4, isEnabled: true, capabilities: ["text-to-image"] };

function withEnv<T>(values: Record<string, string | undefined>, run: () => Promise<T>) {
  const old = Object.fromEntries(Object.keys(values).map((key) => [key, process.env[key]]));
  for (const [key, value] of Object.entries(values)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
  return run().finally(() => { for (const [key, value] of Object.entries(old)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; } });
}

test("Google configuration detects missing, malformed, mismatched and stale browser IDs", () => {
  assert.match(googleConfigurationIssue(undefined)!, /GOOGLE_CLIENT_ID/);
  assert.match(googleConfigurationIssue(undefined, "test.apps.googleusercontent.com")!, /GOOGLE_CLIENT_ID/);
  assert.match(googleConfigurationIssue("server.apps.googleusercontent.com", "browser.apps.googleusercontent.com")!, /does not match/);
  assert.match(googleConfigurationIssue("placeholder")!, /valid/);
  assert.equal(googleConfigurationIssue("test.apps.googleusercontent.com", "test.apps.googleusercontent.com"), null);
});

test("API errors preserve safe configuration and workflow guidance", () => {
  assert.equal(apiErrorMessage({ error: { message: "Dispatch missing.", details: { missing: ["GCP_PROJECT_ID"] } } }, "fail"), "Dispatch missing. Set GCP_PROJECT_ID.");
  assert.match(apiErrorMessage({ error: { message: "Invalid.", details: { issues: ["Model unavailable."] } } }, "fail"), /Model unavailable/);
  assert.equal(apiErrorMessage(null, "fail"), "fail");
});

test("MongoDB errors become actionable failures without driver secrets", async () => {
  for (const failure of [new MongoNetworkError("mongodb://private-user:private-password@host"), new MongoParseError("secret URI"), new MongoServerError({ message: "secret credentials", code: 18 }), new MongoServerError({ message: "secret document", code: 121 })]) {
    const response = http.jsonError(failure);
    assert.equal(response.status, 503);
    const text = await response.text();
    assert.match(text, /CONFIGURATION_REQUIRED/);
    assert.doesNotMatch(text, /private-password|secret URI|secret credentials|secret document/);
  }
});

test("MongoDB can reconnect after a rejected cached connection", async () => {
  await withEnv({ MONGODB_URI: "mongodb://test.invalid", MONGODB_DB_NAME: "astraflow_dev" }, async () => {
    let attempts = 0;
    let closed = 0;
    class FakeClient {
      async connect() { if (++attempts === 1) throw new MongoNetworkError("offline"); return this; }
      async close() { closed++; }
    }
    const globalState = globalThis as typeof globalThis & { astraflowMongoClientPromise?: Promise<unknown> };
    delete globalState.astraflowMongoClientPromise;
    const db = load<typeof import("../src/server/db/mongodb")>("src/server/db/mongodb.ts", { mongodb: { MongoClient: FakeClient } });
    try {
      await assert.rejects(db.getMongoClient());
      await db.getMongoClient();
      assert.equal(attempts, 2);
      assert.equal(closed, 1);
    } finally { delete globalState.astraflowMongoClientPromise; }
  });
});

test("validation stays authoritative for empty, unavailable, compatible and invalid workflows", async () => {
  let models: unknown[] = [enabledModel];
  let dbCalls = 0;
  const route = load<typeof import("../src/app/api/workflows/validate/route")>("src/app/api/workflows/validate/route.ts", {
    "@/server/models/models": { listEnabledModels: async () => { dbCalls++; return models; } }
  });
  const request = (body: unknown) => new Request("http://localhost/api/workflows/validate", { method: "POST", body: JSON.stringify(body) });
  const invalid = await route.POST(request({ nodes: [] }));
  assert.equal(invalid.status, 422);
  assert.equal(dbCalls, 0);
  const valid = await route.POST(request(baseTextToImageWorkflow));
  assert.equal(valid.status, 200);
  assert.equal((await valid.json()).ok, true);
  models = [];
  const empty = await route.POST(request(baseTextToImageWorkflow));
  assert.equal(empty.status, 503);
  assert.match((await empty.json()).error.message, /seed:dev/);
  models = [{ ...enabledModel, id: "different-model" }];
  const missing = await route.POST(request(baseTextToImageWorkflow));
  assert.equal(missing.status, 422);
  assert.match((await missing.json()).issues.join(" "), /unavailable model/);
});

test("validation reports database outages instead of a success-shaped fallback", async () => {
  const route = load<typeof import("../src/app/api/workflows/validate/route")>("src/app/api/workflows/validate/route.ts", { "@/server/models/models": { listEnabledModels: async () => { throw new MongoNetworkError("private connection details"); } } });
  const response = await route.POST(new Request("http://localhost/api/workflows/validate", { method: "POST", body: JSON.stringify(baseTextToImageWorkflow) }));
  assert.equal(response.status, 503);
  assert.match((await response.json()).error.message, /Atlas network access/);
});

test("GIS loader shares loads, reloads failed scripts and reuses a loaded API", async () => {
  const previousWindow = Object.getOwnPropertyDescriptor(globalThis, "window");
  const previousDocument = Object.getOwnPropertyDescriptor(globalThis, "document");
  const scripts: FakeScript[] = [];
  class FakeScript extends EventTarget { src = ""; async = false; remove() { const index = scripts.indexOf(this); if (index >= 0) scripts.splice(index, 1); } }
  const fakeWindow = { google: undefined as unknown, setTimeout, clearTimeout };
  Object.defineProperty(globalThis, "window", { configurable: true, value: fakeWindow });
  Object.defineProperty(globalThis, "document", { configurable: true, value: { querySelector: () => scripts[0], createElement: () => new FakeScript(), head: { appendChild: (script: FakeScript) => scripts.push(script) } } });
  try {
    const failed = loadGoogleScript(100);
    assert.equal(loadGoogleScript(100), failed);
    scripts[0].dispatchEvent(new Event("error"));
    await assert.rejects(failed, /Allow accounts.google.com/);
    assert.equal(scripts.length, 0);
    const loaded = loadGoogleScript(100);
    assert.equal(scripts.length, 1);
    fakeWindow.google = { accounts: { id: {} } };
    scripts[0].dispatchEvent(new Event("load"));
    await loaded;
    await loadGoogleScript(100);
    assert.equal(scripts.length, 1);
    fakeWindow.google = undefined;
    await assert.rejects(loadGoogleScript(5), /could not load/);
    assert.equal(scripts.length, 0);
  } finally {
    if (previousWindow) Object.defineProperty(globalThis, "window", previousWindow); else Reflect.deleteProperty(globalThis, "window");
    if (previousDocument) Object.defineProperty(globalThis, "document", previousDocument); else Reflect.deleteProperty(globalThis, "document");
  }
});

test("generation guidance distinguishes real provider configuration and development placeholders", () => {
  assert.match(generationSetupIssue("gcp-hosted-gpu", { NODE_ENV: "development" })!, /GPU_RUNTIME_UNVERIFIED/);
  assert.match(generationSetupIssue("google-ai-studio-image", { NODE_ENV: "development" })!, /KMS_KEY_RESOURCE/);
  assert.match(generationSetupIssue("external-byok", { NODE_ENV: "development" })!, /no specifically implemented/);
  assert.match(generationSetupIssue("development-fake", { NODE_ENV: "production", GENERATION_LOCAL_WORKER_ENABLED: "true" })!, /non-production/);
  assert.equal(generationSetupIssue("development-fake", { NODE_ENV: "development", GENERATION_LOCAL_WORKER_ENABLED: "true", GENERATION_LOCAL_WORKER_SECRET: "test-only" }), null);
  assert.match(generationSetupIssue("google-ai-studio-image", { NODE_ENV: "development", KMS_KEY_RESOURCE: "test-only" })!, /GCP_TASKS_QUEUE/);
});

test("sign-in verifies identity before persistence and sets a secure HttpOnly cookie", async () => {
  await withEnv({ GOOGLE_CLIENT_ID: "test.apps.googleusercontent.com", NEXT_PUBLIC_GOOGLE_CLIENT_ID: "test.apps.googleusercontent.com" }, async () => {
    const calls: string[] = [];
    let cookieOptions: unknown;
    const route = load<typeof import("../src/app/api/auth/session/route")>("src/app/api/auth/session/route.ts", {
      "@/lib/auth/google": { verifyGoogleIdentityCredential: async () => { calls.push("verify"); return { emailVerified: true }; }, AuthConfigurationError: class extends Error {}, GoogleIdentityError: class extends Error {} },
      "@/server/users/users": { upsertGoogleUser: async () => { calls.push("user"); return { id: "user", role: "STANDARD" }; } },
      "@/server/security/request": { getRequestFingerprint: async () => ({}) },
      "@/server/audit/audit": { writeAuditEvent: async () => { calls.push("audit"); } },
      "@/server/auth/session-store": { createDatabaseSession: async () => { calls.push("session"); return { token: "test-only-opaque-session", session: { id: "session" } }; }, sessionCookieName: "test-cookie", sessionCookieOptions: () => ({ httpOnly: true, secure: true, sameSite: "lax", path: "/" }) },
      "next/headers": { cookies: async () => ({ set: (_name: string, _token: string, options: unknown) => { calls.push("cookie"); cookieOptions = options; } }) }
    });
    const response = await route.POST(new Request("http://localhost/api/auth/session", { method: "POST", body: JSON.stringify({ credential: "test-only-credential-long-enough", clientId: "test.apps.googleusercontent.com" }) }));
    assert.equal(response.status, 200);
    assert.deepEqual(calls, ["verify", "user", "session", "cookie", "audit"]);
    assert.deepEqual(cookieOptions, { httpOnly: true, secure: true, sameSite: "lax", path: "/" });
    assert.doesNotMatch(await response.text(), /credential|opaque-session/);
    calls.length = 0;
    const mismatch = await route.POST(new Request("http://localhost/api/auth/session", { method: "POST", body: JSON.stringify({ credential: "test-only-credential-long-enough", clientId: "stale.apps.googleusercontent.com" }) }));
    assert.equal(mismatch.status, 503);
    assert.equal(calls.length, 0);
  });
});

test("sign-in database failures are not misreported as invalid Google credentials", async () => {
  await withEnv({ GOOGLE_CLIENT_ID: "test.apps.googleusercontent.com", NEXT_PUBLIC_GOOGLE_CLIENT_ID: "test.apps.googleusercontent.com" }, async () => {
    const route = load<typeof import("../src/app/api/auth/session/route")>("src/app/api/auth/session/route.ts", {
      "@/lib/auth/google": { verifyGoogleIdentityCredential: async () => ({ emailVerified: true }), AuthConfigurationError: class extends Error {}, GoogleIdentityError: class extends Error {} },
      "@/server/users/users": { upsertGoogleUser: async () => { throw new MongoNetworkError("private-user:password"); } },
      "@/server/security/request": { getRequestFingerprint: async () => ({}) }
    });
    const response = await route.POST(new Request("http://localhost/api/auth/session", { method: "POST", body: JSON.stringify({ credential: "test-only-credential-long-enough" }) }));
    assert.equal(response.status, 503);
    assert.doesNotMatch(await response.text(), /private-user:password/);
  });
});

test("logout does not report success or clear a cookie when revocation fails", async () => {
  let cleared = false;
  const route = load<typeof import("../src/app/api/auth/session/route")>("src/app/api/auth/session/route.ts", {
    "@/server/auth/session-store": { getCurrentSession: async () => null, revokeCurrentSession: async () => { throw new MongoNetworkError("private connection"); } },
    "next/headers": { cookies: async () => ({ delete: () => { cleared = true; } }) }
  });
  const response = await route.DELETE();
  assert.equal(response.status, 503);
  assert.equal(cleared, false);
});

test("session lookup returns unauthenticated and generation cannot admit an unsigned request", async () => {
  const me = load<typeof import("../src/app/api/me/route")>("src/app/api/me/route.ts", { "@/lib/auth/session": { requireCurrentSession: async () => { throw errors.authenticationRequired(); } } });
  assert.equal((await me.GET()).status, 401);
  let admitted = false;
  const generation = load<typeof import("../src/app/api/generations/route")>("src/app/api/generations/route.ts", {
    "@/lib/auth/session": { requireCurrentSession: async () => { throw errors.authenticationRequired(); } },
    "@/server/generations/generations": { createGenerationJob: async () => { admitted = true; } }
  });
  const response = await generation.POST(new Request("http://localhost/api/generations", { method: "POST", body: "{}" }));
  assert.equal(response.status, 401);
  assert.equal(admitted, false);
});

test("Google token verification uses the server audience and never propagates token-bearing errors", async () => {
  await withEnv({ GOOGLE_CLIENT_ID: "test.apps.googleusercontent.com", NEXT_PUBLIC_GOOGLE_CLIENT_ID: "test.apps.googleusercontent.com" }, async () => {
    let reject = false;
    let verification: unknown;
    class OAuth2Client {
      async verifyIdToken(input: unknown) {
        verification = input;
        if (reject) throw new Error("raw test-only-secret-token");
        return { getPayload: () => ({ sub: "google-subject", email_verified: true }) };
      }
    }
    const google = load<typeof import("../src/lib/auth/google")>("src/lib/auth/google.ts", { "google-auth-library": { OAuth2Client } });
    const user = await google.verifyGoogleIdentityCredential("test-only-secret-token");
    assert.equal(user.providerUserId, "google-subject");
    assert.deepEqual(verification, { audience: "test.apps.googleusercontent.com", idToken: "test-only-secret-token" });
    reject = true;
    await assert.rejects(google.verifyGoogleIdentityCredential("test-only-secret-token"), (error: unknown) => error instanceof google.GoogleIdentityError && !error.message.includes("test-only-secret-token"));
  });
});

test("successful logout revokes the session before clearing its cookie", async () => {
  const calls: string[] = [];
  const route = load<typeof import("../src/app/api/auth/session/route")>("src/app/api/auth/session/route.ts", {
    "@/server/auth/session-store": { getCurrentSession: async () => ({ userId: "user", sessionId: "session" }), revokeCurrentSession: async () => { calls.push("revoke"); }, sessionCookieName: "test-cookie" },
    "@/server/security/request": { getRequestFingerprint: async () => ({}) },
    "@/server/audit/audit": { writeAuditEvent: async () => { calls.push("audit"); } },
    "next/headers": { cookies: async () => ({ delete: () => { calls.push("cookie"); } }) }
  });
  assert.equal((await route.DELETE()).status, 200);
  assert.deepEqual(calls, ["revoke", "cookie", "audit"]);
});

test("generation HTTP acceptance returns the job state without claiming a generated image", async () => {
  const route = load<typeof import("../src/app/api/generations/route")>("src/app/api/generations/route.ts", {
    "@/lib/auth/session": { requireCurrentSession: async () => ({ userId: "user", role: "standard" }) },
    "@/server/security/request": { getRequestFingerprint: async () => ({}) },
    "@/server/audit/audit": { writeAuditEvent: async () => undefined },
    "@/server/generations/generations": { createGenerationJob: async () => ({ job: { id: "job", status: "QUEUED", executionEnvironment: "development-local" }, idempotentReplay: false }) }
  });
  const response = await route.POST(new Request("http://localhost/api/generations", { method: "POST", body: JSON.stringify({ workflow: baseTextToImageWorkflow, idempotencyKey: "test-submission-key" }) }));
  assert.equal(response.status, 202);
  const body = await response.json();
  assert.equal(body.job.status, "QUEUED");
  assert.equal(body.job.executionEnvironment, "development-local");
  assert.equal(body.image, undefined);
});
