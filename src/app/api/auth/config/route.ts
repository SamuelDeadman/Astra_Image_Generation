import { NextResponse } from "next/server";
import { googleClientIdIssue } from "@/lib/auth/configuration";
import { configurationRequired } from "@/server/errors";
import { jsonError } from "@/server/http";

export const runtime = "nodejs";

export async function GET() {
  const clientId = process.env.GOOGLE_CLIENT_ID?.trim();
  const issue = googleClientIdIssue(clientId);
  if (issue) return jsonError(configurationRequired(issue));
  return NextResponse.json({ clientId }, { headers: { "Cache-Control": "no-store" } });
}
