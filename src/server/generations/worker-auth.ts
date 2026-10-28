import crypto from "node:crypto";
import { OAuth2Client } from "google-auth-library";
import { isLocalGenerationWorkerEnabled, getLocalGenerationWorkerSecret, type WorkerEnvironment } from "./worker-config";

export type WorkerIdentity = {
  mode: "oidc" | "local";
  email?: string;
  audience?: string | string[];
  issuer?: string;
};

export type WorkerAuthResult =
  | {
      ok: true;
      identity: WorkerIdentity;
    }
  | {
      ok: false;
      status: 401 | 503;
      code: "WORKER_AUTH_REQUIRED" | "WORKER_AUTH_CONFIG_REQUIRED";
    };

export type WorkerAuthConfig = {
  localWorkerEnabled: boolean;
  localSecret?: string;
  expectedAudience?: string;
  expectedServiceAccountEmail?: string;
  nodeEnv?: string;
};

export type VerifiedOidcPayload = {
  iss?: string;
  aud?: string | string[];
  email?: string;
  email_verified?: boolean;
};

type VerifyOidcToken = (input: { idToken: string; audience: string }) => Promise<VerifiedOidcPayload | null>;

const googleOidcIssuers = new Set(["accounts.google.com", "https://accounts.google.com"]);
let oauth2Client: OAuth2Client | undefined;

function getOAuth2Client() {
  oauth2Client ??= new OAuth2Client();
  return oauth2Client;
}

function getBearerToken(headers: Headers) {
  const authorization = headers.get("authorization") ?? "";
  const [scheme, token] = authorization.split(" ");

  if (scheme !== "Bearer" || !token) {
    return null;
  }

  return token;
}

function constantTimeEqual(left: string, right: string) {
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);

  if (leftBuffer.length !== rightBuffer.length) {
    return false;
  }

  return crypto.timingSafeEqual(leftBuffer, rightBuffer);
}

function getWorkerAuthConfig(env: WorkerEnvironment = process.env): WorkerAuthConfig {
  return {
    localWorkerEnabled: isLocalGenerationWorkerEnabled(env, env.NODE_ENV),
    localSecret: getLocalGenerationWorkerSecret(env),
    expectedAudience: env.WORKER_AUDIENCE,
    expectedServiceAccountEmail: env.WORKER_INVOKER_SERVICE_ACCOUNT_EMAIL,
    nodeEnv: env.NODE_ENV
  };
}

async function verifyWithGoogle(input: { idToken: string; audience: string }) {
  const ticket = await getOAuth2Client().verifyIdToken({
    idToken: input.idToken,
    audience: input.audience
  });

  return ticket.getPayload() ?? null;
}

export async function authenticateGenerationWorkerRequest(
  headers: Headers,
  options?: {
    env?: WorkerEnvironment;
    config?: WorkerAuthConfig;
    verifyOidcToken?: VerifyOidcToken;
  }
): Promise<WorkerAuthResult> {
  const config = options?.config ?? getWorkerAuthConfig(options?.env);
  const production = config.nodeEnv === "production";

  if (config.localWorkerEnabled && !production) {
    if (!config.localSecret) {
      return { ok: false, status: 503, code: "WORKER_AUTH_CONFIG_REQUIRED" };
    }

    const suppliedSecret = headers.get("x-astraflow-local-worker-secret");

    if (!suppliedSecret || !constantTimeEqual(suppliedSecret, config.localSecret)) {
      return { ok: false, status: 401, code: "WORKER_AUTH_REQUIRED" };
    }

    return {
      ok: true,
      identity: {
        mode: "local"
      }
    };
  }

  if (!config.expectedAudience || !config.expectedServiceAccountEmail) {
    return { ok: false, status: 503, code: "WORKER_AUTH_CONFIG_REQUIRED" };
  }

  const token = getBearerToken(headers);

  if (!token) {
    return { ok: false, status: 401, code: "WORKER_AUTH_REQUIRED" };
  }

  let payload: VerifiedOidcPayload | null;

  try {
    payload = await (options?.verifyOidcToken ?? verifyWithGoogle)({
      idToken: token,
      audience: config.expectedAudience
    });
  } catch {
    return { ok: false, status: 401, code: "WORKER_AUTH_REQUIRED" };
  }

  if (
    !payload ||
    !payload.iss ||
    !googleOidcIssuers.has(payload.iss) ||
    payload.email !== config.expectedServiceAccountEmail ||
    payload.email_verified !== true
  ) {
    return { ok: false, status: 401, code: "WORKER_AUTH_REQUIRED" };
  }

  const audienceMatches = Array.isArray(payload.aud)
    ? payload.aud.includes(config.expectedAudience)
    : payload.aud === config.expectedAudience;

  if (!audienceMatches) {
    return { ok: false, status: 401, code: "WORKER_AUTH_REQUIRED" };
  }

  return {
    ok: true,
    identity: {
      mode: "oidc",
      email: payload.email,
      audience: payload.aud,
      issuer: payload.iss
    }
  };
}
