import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import { z } from "zod";
import { verifyGoogleIdentityCredential, AuthConfigurationError, GoogleIdentityError } from "@/lib/auth/google";
import { googleConfigurationIssue } from "@/lib/auth/configuration";
import {
  createDatabaseSession,
  getCurrentSession,
  revokeCurrentSession,
  sessionCookieName,
  sessionCookieOptions
} from "@/server/auth/session-store";
import { writeAuditEvent } from "@/server/audit/audit";
import { authenticationRequired, configurationRequired, validationFailed } from "@/server/errors";
import { jsonError } from "@/server/http";
import { assertNotSuspended, mapRole } from "@/server/auth/roles";
import { getRequestFingerprint } from "@/server/security/request";
import { upsertGoogleUser } from "@/server/users/users";

export const runtime = "nodejs";

const sessionRequestSchema = z.object({
  credential: z.string().min(20).max(20000),
  clientId: z.string().optional()
});

export async function POST(request: Request) {
  const body = await request.json().catch(() => null);
  const parsed = sessionRequestSchema.safeParse(body);

  if (!parsed.success) {
    return NextResponse.json({ error: "Invalid sign-in payload." }, { status: 400 });
  }

  try {
    const issue = googleConfigurationIssue(process.env.GOOGLE_CLIENT_ID, parsed.data.clientId ?? process.env.GOOGLE_CLIENT_ID);
    if (issue) throw configurationRequired(issue);
    const googleUser = await verifyGoogleIdentityCredential(parsed.data.credential);

    if (!googleUser.emailVerified) {
      throw validationFailed("Google account email address is not verified.");
    }

    const fingerprint = await getRequestFingerprint();
    const user = await upsertGoogleUser(googleUser);
    const role = mapRole(user.role);
    assertNotSuspended(role);

    const { token, session } = await createDatabaseSession({
      userId: user.id,
      ipHash: fingerprint.ipHash,
      userAgent: fingerprint.userAgent
    });

    const cookieStore = await cookies();
    cookieStore.set(sessionCookieName, token, sessionCookieOptions());

    await writeAuditEvent({
      userId: user.id,
      actorUserId: user.id,
      eventType: "auth.session.created",
      targetType: "user_session",
      targetId: session.id,
      ipHash: fingerprint.ipHash,
      userAgent: fingerprint.userAgent
    });

    return NextResponse.json({
      user: {
        id: user.id,
        email: user.email,
        displayName: user.displayName,
        role
      }
    });
  } catch (error) {
    if (error instanceof AuthConfigurationError) {
      return jsonError(configurationRequired(error.message));
    }
    if (error instanceof GoogleIdentityError) return jsonError(authenticationRequired(error.message));
    return jsonError(error);
  }
}

export async function DELETE() {
  try {
    const session = await getCurrentSession();
    await revokeCurrentSession("LOGOUT");
    const cookieStore = await cookies();
    cookieStore.delete(sessionCookieName);
    if (session) {
      const fingerprint = await getRequestFingerprint();
      await writeAuditEvent({
        userId: session.userId,
        actorUserId: session.userId,
        eventType: "auth.session.revoked",
        targetType: "user_session",
        targetId: session.sessionId,
        ipHash: fingerprint.ipHash,
        userAgent: fingerprint.userAgent
      });
    }
    return NextResponse.json({ ok: true });
  } catch (error) {
    return jsonError(error);
  }
}
