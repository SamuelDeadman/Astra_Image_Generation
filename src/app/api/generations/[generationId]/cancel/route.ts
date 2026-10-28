import { NextResponse } from "next/server";
import { requireCurrentSession } from "@/lib/auth/session";
import { writeAuditEvent } from "@/server/audit/audit";
import { cancelGenerationJob } from "@/server/generations/generations";
import { jsonError } from "@/server/http";
import { getRequestFingerprint } from "@/server/security/request";

export const runtime = "nodejs";

export async function POST(_request: Request, { params }: { params: Promise<{ generationId: string }> }) {
  try {
    const session = await requireCurrentSession();
    const { generationId } = await params;
    const job = await cancelGenerationJob(session.userId, generationId);
    const fingerprint = await getRequestFingerprint();

    await writeAuditEvent({
      userId: session.userId,
      actorUserId: session.userId,
      eventType: "generation.job.cancelled",
      targetType: "generation_job",
      targetId: job.id,
      ipHash: fingerprint.ipHash,
      userAgent: fingerprint.userAgent
    });

    return NextResponse.json({ job });
  } catch (error) {
    return jsonError(error);
  }
}
