import { NextResponse } from "next/server";
import { requireCurrentSession } from "@/lib/auth/session";
import { jsonError } from "@/server/http";

export const runtime = "nodejs";

export async function GET() {
  try {
    await requireCurrentSession();
    return NextResponse.json({ providers: [], credentials: [] });
  } catch (error) {
    return jsonError(error);
  }
}
