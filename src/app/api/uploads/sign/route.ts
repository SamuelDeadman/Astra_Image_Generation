import { NextResponse } from "next/server";
import { z } from "zod";
import { requireCurrentSession } from "@/lib/auth/session";
import { signUserUpload } from "@/server/assets/assets";
import { writeAuditEvent } from "@/server/audit/audit";
import { jsonError } from "@/server/http";
import { getRequestFingerprint } from "@/server/security/request";

export const runtime = "nodejs";

const signUploadSchema = z.object({
  filename: z.string().min(1).max(180),
  contentType: z.string().min(3).max(120),
  sizeBytes: z.number().int().min(1)
});

export async function POST(request: Request) {
  try {
    const session = await requireCurrentSession();
    const body = await request.json().catch(() => null);
    const parsed = signUploadSchema.safeParse(body);

    if (!parsed.success) {
      return NextResponse.json({ error: "Invalid upload signing payload.", issues: parsed.error.issues }, { status: 400 });
    }

    const result = await signUserUpload({
      ownerId: session.userId,
      filename: parsed.data.filename,
      contentType: parsed.data.contentType,
      sizeBytes: parsed.data.sizeBytes
    });
    const fingerprint = await getRequestFingerprint();

    await writeAuditEvent({
      userId: session.userId,
      actorUserId: session.userId,
      eventType: "asset.upload.signed",
      targetType: "asset",
      targetId: result.asset.id,
      ipHash: fingerprint.ipHash,
      userAgent: fingerprint.userAgent,
      metadata: {
        contentType: parsed.data.contentType,
        sizeBytes: parsed.data.sizeBytes
      }
    });

    return NextResponse.json(result, { status: 201 });
  } catch (error) {
    return jsonError(error);
  }
}
