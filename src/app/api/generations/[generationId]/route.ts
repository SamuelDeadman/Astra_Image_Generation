import { NextResponse } from "next/server";
import { requireCurrentSession } from "@/lib/auth/session";
import { getGenerationJob } from "@/server/generations/generations";
import { jsonError } from "@/server/http";

export const runtime = "nodejs";

export async function GET(_request: Request, { params }: { params: Promise<{ generationId: string }> }) {
  try {
    const session = await requireCurrentSession();
    const { generationId } = await params;
    const job = await getGenerationJob(session.userId, generationId);

    return NextResponse.json({ job });
  } catch (error) {
    return jsonError(error);
  }
}
