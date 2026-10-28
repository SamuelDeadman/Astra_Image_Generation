import { NextResponse } from "next/server";
import { requireCurrentSession } from "@/lib/auth/session";
import { assertRole } from "@/server/auth/roles";
import { listModels } from "@/server/models/models";
import { getCurrentSession } from "@/lib/auth/session";
import { hasProviderCredential } from "@/server/providers/credentials";
import { generationSetupIssue } from "@/server/generations/readiness";
import { jsonError } from "@/server/http";

export const runtime = "nodejs";

export async function GET(request: Request) {
  try {
    const includeDisabled = new URL(request.url).searchParams.get("includeDisabled") === "true";

    if (includeDisabled) {
      const session = await requireCurrentSession();
      assertRole(session.role, ["administrator", "model-manager"]);
      const models = await listModels({ includeDisabled: true });

      return NextResponse.json({
        models,
        setupRequired: models.length === 0
      });
    }

    const models = await listModels();
    const session = await getCurrentSession();
    const hasGoogleCredential = session && models.some((model) => model.route === "google-ai-studio-image") ? await hasProviderCredential(session.userId, "google-ai-studio") : false;
    for (const model of models) {
      if (model.route === "google-ai-studio-image" && model.availability !== "unavailable" && !generationSetupIssue(model.route)) {
        model.availability = hasGoogleCredential ? "available" : "requires-credentials";
        model.generationUnavailableReason = hasGoogleCredential ? undefined : "Save your Google AI Studio API key in BYOK Providers. Credentials are encrypted and scoped to your account.";
      }
    }
    return NextResponse.json({
      models,
      setupRequired: models.length === 0
    }, { headers: { "Cache-Control": "private, no-store" } });
  } catch (error) {
    return jsonError(error);
  }
}
