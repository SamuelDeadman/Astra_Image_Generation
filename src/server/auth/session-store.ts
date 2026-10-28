import "server-only";

import { cookies } from "next/headers";
import { nanoid } from "nanoid";
import { authenticationRequired } from "@/server/errors";
import { mapRole, type AppRole } from "@/server/auth/roles";
import { createOpaqueToken, hashOpaqueToken } from "@/server/security/request";
import { mongoCollection } from "@/server/db/mongodb";
import { collectionNames, type SessionDocument, type UserDocument } from "@/server/db/types";

export const sessionCookieName =
  process.env.NODE_ENV === "production" ? "__Host_astraflow_session" : "astraflow_session";

const sessionTtlMs = 1000 * 60 * 60 * 12;

export type CurrentSession = {
  sessionId: string;
  userId: string;
  providerUserId: string;
  email?: string;
  displayName?: string;
  role: AppRole;
};

export function sessionCookieOptions() {
  return {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax" as const,
    path: "/",
    maxAge: Math.floor(sessionTtlMs / 1000)
  };
}

export async function createDatabaseSession(input: {
  userId: string;
  ipHash?: string;
  userAgent?: string;
}) {
  const sessions = await mongoCollection<SessionDocument>(collectionNames.sessions);
  const token = createOpaqueToken();
  const now = new Date();
  const expiresAt = new Date(Date.now() + sessionTtlMs);
  const session: SessionDocument = {
    _id: nanoid(),
    userId: input.userId,
    tokenHash: hashOpaqueToken(token),
    ...(input.ipHash ? { ipHash: input.ipHash } : {}),
    ...(input.userAgent ? { userAgent: input.userAgent } : {}),
    createdAt: now,
    lastSeenAt: now,
    expiresAt
  };

  await sessions.insertOne(session);

  return { token, session: { ...session, id: session._id } };
}

export async function getCurrentSession(): Promise<CurrentSession | null> {
  const cookieStore = await cookies();
  const token = cookieStore.get(sessionCookieName)?.value;

  if (!token) {
    return null;
  }

  const sessions = await mongoCollection<SessionDocument>(collectionNames.sessions);
  const users = await mongoCollection<UserDocument>(collectionNames.users);
  const session = await sessions.findOne({
    tokenHash: hashOpaqueToken(token),
    revokedAt: { $exists: false },
    expiresAt: { $gt: new Date() }
  });

  if (!session) {
    return null;
  }

  const user = await users.findOne({
    _id: session.userId,
    deletedAt: { $exists: false },
    isSuspended: false
  });

  if (!user) {
    return null;
  }

  await sessions.updateOne({ _id: session._id }, { $set: { lastSeenAt: new Date() } });

  return {
    sessionId: session._id,
    userId: user._id,
    providerUserId: user.providerUserId,
    email: user.email,
    displayName: user.displayName,
    role: mapRole(user.role)
  };
}

export async function requireCurrentSession() {
  const session = await getCurrentSession();

  if (!session) {
    throw authenticationRequired();
  }

  return session;
}

export async function revokeCurrentSession(reason: "LOGOUT" | "ADMIN_REVOKED" = "LOGOUT") {
  const cookieStore = await cookies();
  const token = cookieStore.get(sessionCookieName)?.value;

  if (!token) {
    return;
  }

  const sessions = await mongoCollection<SessionDocument>(collectionNames.sessions);
  await sessions.updateMany(
    {
      tokenHash: hashOpaqueToken(token),
      revokedAt: { $exists: false }
    },
    {
      $set: {
        revokedAt: new Date(),
        revocationReason: reason
      }
    }
  );
}
