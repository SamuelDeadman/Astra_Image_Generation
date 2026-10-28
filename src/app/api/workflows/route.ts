import { NextResponse } from "next/server";
import { z } from "zod";
import { requireCurrentSession } from "@/lib/auth/session";
import { writeAuditEvent } from "@/server/audit/audit";
import { createWorkflowVersion, listWorkflows } from "@/server/workflows/workflows";
import { jsonError } from "@/server/http";
import { getRequestFingerprint } from "@/server/security/request";

export const runtime = "nodejs";

const workflowCreateSchema = z.object({
  name: z.string().min(1).max(120),
  folderId: z.string().min(1).optional(),
  workflow: z.unknown()
});

export async function GET() {
  try {
    const session = await requireCurrentSession();
    const workflows = await listWorkflows(session.userId);
    return NextResponse.json({ workflows });
  } catch (error) {
    return jsonError(error);
  }
}

export async function POST(request: Request) {
  try {
    const session = await requireCurrentSession();
    const body = await request.json().catch(() => null);
    const parsed = workflowCreateSchema.safeParse(body);

    if (!parsed.success) {
      return NextResponse.json({ error: "Invalid workflow payload.", issues: parsed.error.issues }, { status: 400 });
    }

    const result = await createWorkflowVersion({
      ownerId: session.userId,
      name: parsed.data.name,
      folderId: parsed.data.folderId,
      workflow: parsed.data.workflow
    });
    const fingerprint = await getRequestFingerprint();

    await writeAuditEvent({
      userId: session.userId,
      actorUserId: session.userId,
      eventType: "workflow.created",
      targetType: "workflow",
      targetId: result.workflow.id,
      ipHash: fingerprint.ipHash,
      userAgent: fingerprint.userAgent,
      metadata: {
        revision: result.workflow.revision,
        selectedModel: result.version.selectedModel,
        executionEnvironment: result.version.executionEnvironment
      }
    });

    return NextResponse.json(result, { status: 201 });
  } catch (error) {
    return jsonError(error);
  }
}
