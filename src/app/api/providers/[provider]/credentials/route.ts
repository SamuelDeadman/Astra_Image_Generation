import { NextResponse } from "next/server";
import { requireCurrentSession } from "@/lib/auth/session";
import { writeAuditEvent } from "@/server/audit/audit";
import { deleteProviderCredential } from "@/server/providers/credentials";
import { getRequestFingerprint } from "@/server/security/request";
import { jsonError } from "@/server/http";

export const runtime = "nodejs";

export async function POST() {
  try {
    await requireCurrentSession();
    return NextResponse.json({ error: { code: "PROVIDER_DISABLED", message: "User-supplied provider credentials are disabled. The GCP L4 Ollama worker uses the application identity." } }, { status: 410 });
  } catch (error) {
    return jsonError(error);
  }
}

export async function DELETE(_request: Request, { params }: { params: Promise<{ provider: string }> }) {
  try {
    const session = await requireCurrentSession();
    const { provider } = await params;
    await deleteProviderCredential({ ownerId: session.userId, providerId: provider });
    const fingerprint = await getRequestFingerprint();

    await writeAuditEvent({
      userId: session.userId,
      actorUserId: session.userId,
      eventType: "provider.credential.deleted",
      targetType: "api_credential",
      ipHash: fingerprint.ipHash,
      userAgent: fingerprint.userAgent,
      metadata: { provider }
    });

    return NextResponse.json({ ok: true, provider });
  } catch (error) {
    return jsonError(error);
  }
}
