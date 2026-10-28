import { NextResponse } from "next/server";
import { z } from "zod";
import { requireCurrentSession } from "@/lib/auth/session";
import { writeAuditEvent } from "@/server/audit/audit";
import { archiveWorkflow, createWorkflowVersion, getWorkflow } from "@/server/workflows/workflows";
import { jsonError } from "@/server/http";
import { getRequestFingerprint } from "@/server/security/request";

export const runtime = "nodejs";

const workflowUpdateSchema = z.object({
  name: z.string().min(1).max(120),
  folderId: z.string().min(1).optional(),
  workflow: z.unknown()
});

export async function GET(_request: Request, { params }: { params: Promise<{ workflowId: string }> }) {
  try {
    const session = await requireCurrentSession();
    const { workflowId } = await params;
    const workflow = await getWorkflow(session.userId, workflowId);

    return NextResponse.json({ workflow });
  } catch (error) {
    return jsonError(error);
  }
}

export async function PUT(request: Request, { params }: { params: Promise<{ workflowId: string }> }) {
  try {
    const session = await requireCurrentSession();
    const { workflowId } = await params;
    const body = await request.json().catch(() => null);
    const parsed = workflowUpdateSchema.safeParse(body);

    if (!parsed.success) {
      return NextResponse.json({ error: "Invalid workflow payload.", issues: parsed.error.issues }, { status: 400 });
    }

    const result = await createWorkflowVersion({
      ownerId: session.userId,
      workflowId,
      name: parsed.data.name,
      folderId: parsed.data.folderId,
      workflow: parsed.data.workflow
    });
    const fingerprint = await getRequestFingerprint();

    await writeAuditEvent({
      userId: session.userId,
      actorUserId: session.userId,
      eventType: "workflow.revision.created",
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

    return NextResponse.json(result);
  } catch (error) {
    return jsonError(error);
  }
}

export async function DELETE(_request: Request, { params }: { params: Promise<{ workflowId: string }> }) {
  try {
    const session = await requireCurrentSession();
    const { workflowId } = await params;
    await archiveWorkflow(session.userId, workflowId);
    const fingerprint = await getRequestFingerprint();

    await writeAuditEvent({
      userId: session.userId,
      actorUserId: session.userId,
      eventType: "workflow.archived",
      targetType: "workflow",
      targetId: workflowId,
      ipHash: fingerprint.ipHash,
      userAgent: fingerprint.userAgent
    });

    return NextResponse.json({ ok: true });
  } catch (error) {
    return jsonError(error);
  }
}
