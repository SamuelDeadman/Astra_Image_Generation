export async function fetchWithTimeout(input: RequestInfo | URL, init?: RequestInit, timeoutMs = 20000) {
  return fetch(input, { ...init, signal: AbortSignal.timeout(timeoutMs) });
}

export function apiErrorMessage(payload: unknown, fallback: string) {
  if (!payload || typeof payload !== "object" || !("error" in payload)) return fallback;
  const error = payload.error;
  if (typeof error === "string") return error;
  if (!error || typeof error !== "object") return fallback;
  const message = "message" in error && typeof error.message === "string" ? error.message : fallback;
  const details = "details" in error ? error.details : null;
  if (details && typeof details === "object") {
    if ("missing" in details && Array.isArray(details.missing)) return `${message} Set ${details.missing.filter((value) => typeof value === "string").join(", ")}.`;
    if ("issues" in details && Array.isArray(details.issues)) return `${message} ${details.issues.filter((value) => typeof value === "string").join(" ")}`;
  }
  return message;
}
