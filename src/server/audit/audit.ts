import "server-only";

import { nanoid } from "nanoid";
import { redactForLogging } from "@/lib/security/redaction";
import { mongoCollection } from "@/server/db/mongodb";
import { collectionNames, type AuditEventDocument } from "@/server/db/types";

type AuditInput = {
  userId?: string;
  actorUserId?: string;
  eventType: string;
  targetType: string;
  targetId?: string;
  referenceId?: string;
  ipHash?: string;
  userAgent?: string;
  metadata?: Record<string, unknown>;
};

export async function writeAuditEvent(input: AuditInput) {
  try {
    const auditEvents = await mongoCollection<AuditEventDocument>(collectionNames.auditEvents);
    const event: AuditEventDocument = {
      _id: nanoid(),
      ...(input.userId ? { userId: input.userId } : {}),
      ...(input.actorUserId ? { actorUserId: input.actorUserId } : {}),
      eventType: input.eventType,
      targetType: input.targetType,
      ...(input.targetId ? { targetId: input.targetId } : {}),
      ...(input.referenceId ? { referenceId: input.referenceId } : {}),
      ...(input.ipHash ? { ipHash: input.ipHash } : {}),
      ...(input.userAgent ? { userAgent: input.userAgent } : {}),
      ...(input.metadata ? { metadata: redactForLogging(input.metadata) } : {}),
      createdAt: new Date()
    };

    if (input.referenceId) {
      await auditEvents.updateOne(
        { referenceId: input.referenceId },
        { $setOnInsert: event },
        { upsert: true }
      );
      return;
    }

    await auditEvents.insertOne(event);
  } catch (error) {
    console.error("Audit write failed", redactForLogging({ eventType: input.eventType, error }));
  }
}
