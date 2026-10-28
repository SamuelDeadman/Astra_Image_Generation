import { NextResponse } from "next/server";
import { z } from "zod";
import { requireCurrentSession } from "@/lib/auth/session";
import { writeAuditEvent } from "@/server/audit/audit";
import { createGenerationJob, listGenerationJobs } from "@/server/generations/generations";
import { getRequestFingerprint } from "@/server/security/request";
import { jsonError } from "@/server/http";

export const runtime = "nodejs";

const createGenerationSchema = z.object({
  workflow: z.unknown(),
  workflowId: z.string().min(1).optional(),
  workflowName: z.string().min(1).max(120).default("Untitled generation"),
  idempotencyKey: z.string().min(12).max(120)
}).strict();

export async function GET() {
  try {
    const session = await requireCurrentSession();
    const jobs = await listGenerationJobs(session.userId);
    return NextResponse.json({ jobs });
  } catch (error) {
    return jsonError(error);
  }
}

export async function POST(request: Request) {
  try {
    const session = await requireCurrentSession();
    const body = await request.json().catch(() => null);
    const parsed = createGenerationSchema.safeParse(body);

    if (!parsed.success) {
      return NextResponse.json({ error: "Invalid generation payload.", issues: parsed.error.issues }, { status: 400 });
    }

    const result = await createGenerationJob({
      ownerId: session.userId,
      role: session.role,
      workflow: parsed.data.workflow,
      workflowId: parsed.data.workflowId,
      workflowName: parsed.data.workflowName,
      idempotencyKey: parsed.data.idempotencyKey
    });

    if (!result.idempotentReplay) {
      const fingerprint = await getRequestFingerprint();
      await writeAuditEvent({
        userId: session.userId,
        actorUserId: session.userId,
        eventType: "generation.job.created",
        targetType: "generation_job",
        targetId: result.job.id,
        ipHash: fingerprint.ipHash,
        userAgent: fingerprint.userAgent,
        metadata: {
          workflowId: result.job.workflowId,
          modelIds: result.job.modelIds,
          executionEnvironment: result.job.executionEnvironment,
          routeSummary: result.job.routeSummary,
          executionPlanId: result.job.executionPlanId,
          executionPlanHash: result.job.executionPlanHash,
          estimatedCredits: result.job.estimatedCredits,
          reservedCredits: result.job.reservedCredits,
          unlimitedDevelopment: result.job.unlimitedDevelopment === true
        }
      });
    }

    return NextResponse.json(result, { status: result.idempotentReplay ? 200 : 202 });
  } catch (error) {
    return jsonError(error);
  }
}
