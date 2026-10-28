import crypto from "node:crypto";
import type { AssetDocument } from "@/server/db/types";
import type { GeneratedOutputArtifact } from "@/server/generations/worker-contract";

const safeStorageSegmentPattern = /^[a-zA-Z0-9_-]+$/;

function hashOwnerId(ownerId: string) {
  return crypto.createHash("sha256").update(ownerId).digest("hex").slice(0, 20);
}

function extensionForContentType(contentType: GeneratedOutputArtifact["contentType"]) {
  if (contentType === "image/jpeg") {
    return "jpg";
  }

  if (contentType === "image/webp") {
    return "webp";
  }

  return "png";
}

function assertSafeIdSegment(value: string, label: string) {
  if (!safeStorageSegmentPattern.test(value)) {
    throw new Error(`${label} is not a safe storage segment.`);
  }
}

export function buildGeneratedOutputAssetId(input: { jobId: string; attemptId: string; stepId?: string }) {
  const digest = crypto
    .createHash("sha256")
    .update(`${input.jobId}:${input.attemptId}:${input.stepId ?? "final"}`)
    .digest("hex")
    .slice(0, 32);
  return `gen_${digest}`;
}

export function buildGeneratedOutputObjectPath(input: {
  ownerId: string;
  jobId: string;
  attemptId: string;
  stepId?: string;
  contentType: GeneratedOutputArtifact["contentType"];
}) {
  assertSafeIdSegment(input.jobId, "Job ID");
  assertSafeIdSegment(input.attemptId, "Attempt ID");
  if (input.stepId) {
    assertSafeIdSegment(input.stepId, "Step ID");
  }

  return `outputs/${hashOwnerId(input.ownerId)}/${input.jobId}/${input.attemptId}/${input.stepId ?? "final"}.${extensionForContentType(input.contentType)}`;
}

export function createGeneratedOutputAssetDraft(input: {
  ownerId: string;
  jobId: string;
  attemptId: string;
  stepId?: string;
  artifactRole?: "intermediate" | "final";
  artifact: GeneratedOutputArtifact;
}): Omit<AssetDocument, "createdAt"> {
  return {
    _id: buildGeneratedOutputAssetId({ jobId: input.jobId, attemptId: input.attemptId, stepId: input.stepId }),
    ownerId: input.ownerId,
    generationJobId: input.jobId,
    kind: "GENERATED_OUTPUT",
    bucket: input.artifact.storage.bucket,
    objectPath: input.artifact.storage.objectPath,
    contentType: input.artifact.contentType,
    width: input.artifact.width,
    height: input.artifact.height,
    sizeBytes: input.artifact.sizeBytes,
    sha256: input.artifact.sha256,
    isPrivate: true,
    visibility: "PRIVATE",
    metadata: {
      attemptId: input.attemptId,
      stepId: input.stepId,
      artifactRole: input.artifactRole ?? "final",
      ...(input.artifact.developmentOnly
        ? {
            developmentOnly: true,
            label: "DEVELOPMENT ONLY PLACEHOLDER"
          }
        : {})
    }
  };
}
