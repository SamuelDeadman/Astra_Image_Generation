import { NextResponse } from "next/server";
import { requireCurrentSession } from "@/lib/auth/session";
import { jsonError } from "@/server/http";

export const runtime = "nodejs";

export async function GET() {
  try {
    const session = await requireCurrentSession();

    return NextResponse.json({
      user: {
        id: session.userId,
        email: session.email,
        displayName: session.displayName,
        role: session.role
      }
    });
  } catch (error) {
    return jsonError(error);
  }
}
