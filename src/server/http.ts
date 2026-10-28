import "server-only";

import { NextResponse } from "next/server";
import { AppError } from "@/server/errors";
import { redactForLogging } from "@/lib/security/redaction";
import { mongoFailure, safeErrorMetadata } from "@/server/db/failures";

export function jsonOk<T>(body: T, init?: ResponseInit) {
  return NextResponse.json(body, init);
}

export function jsonError(error: unknown) {
  const databaseFailure = mongoFailure(error);
  if (databaseFailure) {
    console.error("MongoDB route failure", safeErrorMetadata(error));
    error = databaseFailure;
  }
  if (error instanceof AppError) {
    const logPayload = redactForLogging({
      code: error.code,
      status: error.status,
      message: error.message,
      details: error.details
    });

    if (error.status >= 500) {
      console.error("Handled route error", logPayload);
    } else {
      console.warn("Handled route error", logPayload);
    }

    return NextResponse.json(
      {
        error: {
          code: error.code,
          message: error.message,
          details: error.details
        }
      },
      { status: error.status }
    );
  }

  console.error("Unhandled route error", safeErrorMetadata(error));

  return NextResponse.json(
    {
      error: {
        code: "INTERNAL_ERROR",
        message: "The request could not be completed."
      }
    },
    { status: 500 }
  );
}

export async function parseJson(request: Request) {
  return request.json().catch(() => null);
}
