import { NextResponse } from "next/server";
import { estimateGenerationCredits, validateWorkflow } from "@/lib/workflow/schema";
import { listEnabledModels } from "@/server/models/models";
import { configurationRequired } from "@/server/errors";
import { jsonError } from "@/server/http";

export const runtime = "nodejs";

export async function POST(request: Request) {
  try {
    const body = await request.json().catch(() => null);
    const structural = validateWorkflow(body);

    if (!structural.ok) {
      return NextResponse.json({ ok: false, issues: structural.issues }, { status: 422 });
    }

    const validationModels = await listEnabledModels();
    if (validationModels.length === 0) throw configurationRequired("No enabled models are available. Configure MongoDB, run controlled /ready setup and npm run seed:dev, and enable both model and provider records.");
    const result = validateWorkflow(body, {
      models: validationModels
    });

    if (!result.ok) {
      return NextResponse.json({ ok: false, issues: result.issues }, { status: 422 });
    }

    return NextResponse.json({
      ok: true,
      warnings: result.warnings,
      estimatedCredits: estimateGenerationCredits(result.workflow, validationModels)
    });
  } catch (error) {
    return jsonError(error);
  }
}
