import { NextResponse } from "next/server";
import { requireCurrentSession } from "@/lib/auth/session";
import { listAssetsForUser } from "@/server/assets/assets";
import { jsonError } from "@/server/http";

export const runtime = "nodejs";

export async function GET() {
  try {
    const session = await requireCurrentSession();
    const assets = await listAssetsForUser(session.userId);

    return NextResponse.json({ assets });
  } catch (error) {
    return jsonError(error);
  }
}
