import "server-only";

import crypto from "node:crypto";
import { headers } from "next/headers";

export async function getRequestFingerprint() {
  const headerStore = await headers();
  const forwardedFor = headerStore.get("x-forwarded-for") ?? headerStore.get("x-real-ip") ?? "unknown";
  const userAgent = headerStore.get("user-agent") ?? undefined;
  const ipHash = crypto.createHash("sha256").update(forwardedFor).digest("hex");

  return { ipHash, userAgent };
}

export function hashOpaqueToken(token: string) {
  return crypto.createHash("sha256").update(token).digest("hex");
}

export function createOpaqueToken() {
  return crypto.randomBytes(32).toString("base64url");
}
