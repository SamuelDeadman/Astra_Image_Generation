import { NextResponse } from "next/server";
import { authenticateGenerationWorkerRequest } from "@/server/generations/worker-auth";
import { runGenerationWorkerTask } from "@/server/generations/worker";
import { workerTaskPayloadSchema } from "@/server/generations/worker-contract";
import { redactForLogging } from "@/lib/security/redaction";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function workerError(code: string, status: number) {
  return NextResponse.json(
    {
      error: {
        code,
        message: "Worker request rejected."
      }
    },
    { status }
  );
}

export async function POST(request: Request) {
  const authentication = await authenticateGenerationWorkerRequest(request.headers);

  if (!authentication.ok) {
    return workerError(authentication.code, authentication.status);
  }

  const body = await request.json().catch(() => null);
  const parsed = workerTaskPayloadSchema.safeParse(body);

  if (!parsed.success) {
    return workerError("INVALID_WORKER_TASK_PAYLOAD", 400);
  }

  try {
    const result = await runGenerationWorkerTask(parsed.data);
    const status = result.outcome === "retry" ? 503 : result.outcome === "rejected" ? 202 : 200;

    return NextResponse.json(
      {
        result
      },
      { status }
    );
  } catch (error) {
    console.error("Generation worker request failed", redactForLogging({ error }));
    return workerError("GENERATION_WORKER_UNAVAILABLE", 503);
  }
}

