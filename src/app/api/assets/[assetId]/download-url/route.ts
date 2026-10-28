import { NextResponse } from "next/server";
import { requireCurrentSession } from "@/lib/auth/session";
import { signAssetDownload } from "@/server/assets/assets";
import { jsonError } from "@/server/http";

export const runtime = "nodejs";

export async function GET(_request: Request, { params }: { params: Promise<{ assetId: string }> }) {
  try {
    const session = await requireCurrentSession();
    const { assetId } = await params;
    const result = await signAssetDownload(session.userId, assetId);

    return NextResponse.json(result);
  } catch (error) {
    return jsonError(error);
  }
}
