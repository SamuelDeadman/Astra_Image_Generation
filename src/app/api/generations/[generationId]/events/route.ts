import { requireCurrentSession } from "@/lib/auth/session";
import { jsonError } from "@/server/http";
import { getGenerationJobEvents } from "@/server/generations/generations";

export const runtime = "nodejs";

const encoder = new TextEncoder();

function sse(data: unknown, event = "message") {
  return encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}

export async function GET(_request: Request, { params }: { params: Promise<{ generationId: string }> }) {
  try {
    const session = await requireCurrentSession();
    const { generationId } = await params;
    const { events, snapshot } = await getGenerationJobEvents(session.userId, generationId);

    const stream = new ReadableStream({
      start(controller) {
        for (const event of events) {
          controller.enqueue(sse(event));
        }

        controller.enqueue(sse(snapshot, "snapshot"));
        controller.close();
      }
    });

    return new Response(stream, {
      headers: {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-store",
        Connection: "keep-alive"
      }
    });
  } catch (error) {
    return jsonError(error);
  }
}
