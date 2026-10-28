import { NextResponse } from "next/server";
import { requireCurrentSession } from "@/lib/auth/session";
import { completeUserUpload } from "@/server/assets/assets";
import { writeAuditEvent } from "@/server/audit/audit";
import { jsonError } from "@/server/http";
import { getRequestFingerprint } from "@/server/security/request";

export const runtime = "nodejs";

export async function POST(_request: Request, { params }: { params: Promise<{ assetId: string }> }) {
  try {
    const session = await requireCurrentSession();
    const { assetId } = await params;
    const result = await completeUserUpload(session.userId, assetId);
    const fingerprint = await getRequestFingerprint();

    await writeAuditEvent({
      userId: session.userId,
      actorUserId: session.userId,
      eventType: "asset.upload.completed",
      targetType: "asset",
      targetId: result.asset.id,
      ipHash: fingerprint.ipHash,
      userAgent: fingerprint.userAgent
    });

    return NextResponse.json(result);
  } catch (error) {
    return jsonError(error);
  }
}
