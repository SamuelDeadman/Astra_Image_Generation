import "server-only";

export type AppErrorCode =
  | "CONFIGURATION_REQUIRED"
  | "AUTHENTICATION_REQUIRED"
  | "FORBIDDEN"
  | "NOT_FOUND"
  | "VALIDATION_FAILED"
  | "CONFLICT"
  | "RATE_LIMITED"
  | "UPSTREAM_FAILED";

export class AppError extends Error {
  readonly code: AppErrorCode;
  readonly status: number;
  readonly details?: unknown;

  constructor(code: AppErrorCode, message: string, status: number, details?: unknown) {
    super(message);
    this.name = "AppError";
    this.code = code;
    this.status = status;
    this.details = details;
  }
}

export function configurationRequired(message: string, details?: unknown) {
  return new AppError("CONFIGURATION_REQUIRED", message, 503, details);
}

export function authenticationRequired(message = "Authentication required.") {
  return new AppError("AUTHENTICATION_REQUIRED", message, 401);
}

export function forbidden(message = "Forbidden.") {
  return new AppError("FORBIDDEN", message, 403);
}

export function notFound(message = "Not found.") {
  return new AppError("NOT_FOUND", message, 404);
}

export function validationFailed(message: string, details?: unknown) {
  return new AppError("VALIDATION_FAILED", message, 422, details);
}

export function conflict(message: string, details?: unknown) {
  return new AppError("CONFLICT", message, 409, details);
}
