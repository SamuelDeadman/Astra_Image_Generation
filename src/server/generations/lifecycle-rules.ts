import type { GenerationAttemptStatus, GenerationStatus } from "@/server/db/types";

export const activeGenerationStatuses: GenerationStatus[] = [
  "QUEUED",
  "VALIDATING",
  "STARTING",
  "LOADING_MODEL",
  "GENERATING",
  "POST_PROCESSING",
  "UPLOADING"
];

export const terminalGenerationStatuses: GenerationStatus[] = [
  "COMPLETED",
  "FAILED",
  "CANCELLED",
  "EXPIRED",
  "MODERATION_BLOCKED"
];

export const claimableAttemptStatuses: GenerationAttemptStatus[] = ["DISPATCHED", "RETRYING"];
export const terminalAttemptStatuses: GenerationAttemptStatus[] = ["SUCCEEDED", "FAILED", "CANCELLED"];

const allowedForwardTransitions: Record<GenerationStatus, GenerationStatus[]> = {
  QUEUED: ["VALIDATING", "STARTING", "FAILED", "CANCELLED", "EXPIRED", "MODERATION_BLOCKED"],
  VALIDATING: ["STARTING", "FAILED", "CANCELLED", "EXPIRED", "MODERATION_BLOCKED"],
  STARTING: ["LOADING_MODEL", "GENERATING", "FAILED", "CANCELLED", "EXPIRED", "MODERATION_BLOCKED"],
  LOADING_MODEL: ["GENERATING", "FAILED", "CANCELLED", "EXPIRED", "MODERATION_BLOCKED"],
  GENERATING: ["POST_PROCESSING", "UPLOADING", "FAILED", "CANCELLED", "EXPIRED", "MODERATION_BLOCKED"],
  POST_PROCESSING: ["GENERATING", "UPLOADING", "FAILED", "CANCELLED", "EXPIRED", "MODERATION_BLOCKED"],
  UPLOADING: ["COMPLETED", "FAILED", "CANCELLED", "EXPIRED", "MODERATION_BLOCKED"],
  PAUSED: ["QUEUED", "FAILED", "CANCELLED", "EXPIRED"],
  COMPLETED: [],
  FAILED: [],
  CANCELLED: [],
  EXPIRED: [],
  MODERATION_BLOCKED: []
};

export type AttemptClaimSnapshot = {
  id: string;
  status: GenerationAttemptStatus;
  leaseExpiresAt?: Date;
};

export type AttemptClaimDecision =
  | {
      ok: true;
      staleLease: boolean;
    }
  | {
      ok: false;
      reason:
        | "terminal_job"
        | "workflow_revision_mismatch"
        | "attempt_missing"
        | "attempt_terminal"
        | "attempt_already_active"
        | "attempt_not_claimable";
    };

export function isTerminalGenerationStatus(status: GenerationStatus) {
  return terminalGenerationStatuses.includes(status);
}

export function isActiveGenerationStatus(status: GenerationStatus) {
  return activeGenerationStatuses.includes(status);
}

export function isLegalGenerationTransition(from: GenerationStatus, to: GenerationStatus) {
  if (from === to) {
    return true;
  }

  return allowedForwardTransitions[from]?.includes(to) ?? false;
}

export function canClaimAttempt(input: {
  jobStatus: GenerationStatus;
  jobWorkflowRevisionId: string;
  payloadWorkflowRevisionId: string;
  attempts: AttemptClaimSnapshot[];
  attemptId: string;
  now: Date;
}): AttemptClaimDecision {
  if (isTerminalGenerationStatus(input.jobStatus)) {
    return { ok: false, reason: "terminal_job" };
  }

  if (input.jobWorkflowRevisionId !== input.payloadWorkflowRevisionId) {
    return { ok: false, reason: "workflow_revision_mismatch" };
  }

  const attempt = input.attempts.find((candidate) => candidate.id === input.attemptId);

  if (!attempt) {
    return { ok: false, reason: "attempt_missing" };
  }

  if (terminalAttemptStatuses.includes(attempt.status)) {
    return { ok: false, reason: "attempt_terminal" };
  }

  if (claimableAttemptStatuses.includes(attempt.status)) {
    return { ok: true, staleLease: false };
  }

  if (attempt.status === "ACKNOWLEDGED") {
    if (attempt.leaseExpiresAt && attempt.leaseExpiresAt <= input.now) {
      return { ok: true, staleLease: true };
    }

    return { ok: false, reason: "attempt_already_active" };
  }

  return { ok: false, reason: "attempt_not_claimable" };
}

export function generationCreditReference(
  jobId: string,
  kind: "reservation" | "capture" | "refund"
) {
  return `generation:${jobId}:${kind}`;
}

export function generationAuditReference(jobId: string, attemptId: string, event: string) {
  return `generation:${jobId}:attempt:${attemptId}:${event}`;
}
