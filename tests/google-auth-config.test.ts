import assert from "node:assert/strict";
import test from "node:test";
import { googleClientIdIssue, googleConfigurationIssue } from "../src/lib/auth/configuration";

const clientId = "1234567890-example.apps.googleusercontent.com";

test("runtime Google client ID is required and must have the OAuth client ID format", () => {
  assert.match(googleClientIdIssue() ?? "", /GOOGLE_CLIENT_ID at runtime/);
  assert.match(googleClientIdIssue("invalid-client-id") ?? "", /valid Google OAuth Web application client ID/);
  assert.equal(googleClientIdIssue(clientId), null);
});

test("browser-provided Google client ID must match the server audience when supplied", () => {
  assert.equal(googleConfigurationIssue(clientId), null);
  assert.equal(googleConfigurationIssue(clientId, clientId), null);
  assert.match(googleConfigurationIssue(clientId, "different.apps.googleusercontent.com") ?? "", /does not match/);
});
