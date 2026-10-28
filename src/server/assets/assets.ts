import "server-only";

import { nanoid } from "nanoid";
import type { ClientSession } from "mongodb";
import {
  buildGeneratedOutputObjectPath,
  createGeneratedOutputAssetDraft
} from "@/server/assets/generated-output-contract";
import type { GeneratedOutputArtifact } from "@/server/generations/worker-contract";
import { isLocalGenerationWorkerEnabled } from "@/server/generations/worker-config";
import { createSignedDownloadUrl, createSignedUploadUrl, getStorageObjectMetadata } from "@/server/gcp/storage";
import { notFound, validationFailed } from "@/server/errors";
import { optionalEnv, requiredEnv } from "@/server/env";
import { mongoCollection } from "@/server/db/mongodb";
import { collectionNames, type AssetDocument } from "@/server/db/types";
import { getWorkflowAssetIds, type WorkflowDocument } from "@/lib/workflow/schema";

function toAssetDTO(asset: AssetDocument) {
  return {
    id: asset._id,
    kind: asset.kind,
    contentType: asset.contentType,
    width: asset.width,
    height: asset.height,
    sizeBytes: asset.sizeBytes,
    visibility: asset.visibility,
    uploadState: asset.uploadState,
    createdAt: asset.createdAt.toISOString(),
    uploadCompletedAt: asset.uploadCompletedAt?.toISOString()
  };
}

export async function signUserUpload(input: {
  ownerId: string;
  filename: string;
  contentType: string;
  sizeBytes: number;
}) {
  const signed = await createSignedUploadUrl(input);
  const assets = await mongoCollection<AssetDocument>(collectionNames.assets);
  const asset: AssetDocument = {
    _id: nanoid(),
    ownerId: input.ownerId,
    kind: "USER_UPLOAD",
    bucket: signed.bucket,
    objectPath: signed.objectPath,
    contentType: input.contentType,
    sizeBytes: input.sizeBytes,
    isPrivate: true,
    visibility: "PRIVATE",
    uploadState: "PENDING",
    createdAt: new Date()
  };

  await assets.insertOne(asset);

  return {
    asset: toAssetDTO(asset),
    upload: signed
  };
}

export async function completeUserUpload(ownerId: string, assetId: string) {
  const assets = await mongoCollection<AssetDocument>(collectionNames.assets);
  const asset = await assets.findOne({
    _id: assetId,
    ownerId,
    kind: "USER_UPLOAD",
    deletedAt: { $exists: false }
  });

  if (!asset) {
    throw notFound("Asset not found.");
  }

  const metadata = await getStorageObjectMetadata({
    bucket: asset.bucket,
    objectPath: asset.objectPath
  });

  if (!metadata) {
    throw validationFailed("Upload object was not found in private storage.");
  }

  if (metadata.contentType && metadata.contentType !== asset.contentType) {
    throw validationFailed("Upload content type does not match the signed request.");
  }

  const now = new Date();
  await assets.updateOne(
    { _id: asset._id, ownerId },
    {
      $set: {
        uploadState: "COMPLETED",
        uploadCompletedAt: now,
        ...(metadata.sizeBytes ? { sizeBytes: metadata.sizeBytes } : {})
      }
    }
  );

  return {
    asset: toAssetDTO({
      ...asset,
      uploadState: "COMPLETED",
      uploadCompletedAt: now,
      ...(metadata.sizeBytes ? { sizeBytes: metadata.sizeBytes } : {})
    })
  };
}

export async function listAssetsForUser(ownerId: string) {
  const assets = await mongoCollection<AssetDocument>(collectionNames.assets);
  const records = await assets
    .find({
      ownerId,
      deletedAt: { $exists: false },
      visibility: { $in: ["PRIVATE", "UNLISTED_SHARE", "PUBLIC_GALLERY"] },
      $or: [{ kind: { $ne: "USER_UPLOAD" } }, { uploadState: "COMPLETED" }]
    })
    .sort({ createdAt: -1 })
    .limit(48)
    .toArray();

  return records.map(toAssetDTO);
}

export async function assertWorkflowAssetsOwned(ownerId: string, workflow: WorkflowDocument) {
  const assetIds = getWorkflowAssetIds(workflow);

  if (assetIds.length === 0) {
    return;
  }

  const assets = await mongoCollection<AssetDocument>(collectionNames.assets);
  const records = await assets
    .find({
      _id: { $in: assetIds },
      ownerId,
      deletedAt: { $exists: false },
      $or: [{ kind: { $ne: "USER_UPLOAD" } }, { uploadState: "COMPLETED" }]
    })
    .project<{ _id: string }>({ _id: 1 })
    .toArray();
  const found = new Set(records.map((asset) => asset._id));
  const missing = assetIds.filter((assetId) => !found.has(assetId));

  if (missing.length > 0) {
    throw validationFailed("Starting image assets must be completed uploads owned by this account.", {
      missingAssetIds: missing
    });
  }
}

export async function getOwnedWorkflowAssetReferences(ownerId: string, workflow: WorkflowDocument) {
  const assetIds = getWorkflowAssetIds(workflow);

  if (assetIds.length === 0) {
    return [];
  }

  const assets = await mongoCollection<AssetDocument>(collectionNames.assets);
  const records = await assets
    .find({
      _id: { $in: assetIds },
      ownerId,
      deletedAt: { $exists: false },
      $or: [{ kind: { $ne: "USER_UPLOAD" } }, { uploadState: "COMPLETED" }]
    })
    .toArray();
  const found = new Set(records.map((asset) => asset._id));
  const missing = assetIds.filter((assetId) => !found.has(assetId));

  if (missing.length > 0) {
    throw validationFailed("Starting image assets must be completed uploads owned by this account.", {
      missingAssetIds: missing
    });
  }

  return records.map((asset) => ({
    assetId: asset._id,
    kind: asset.kind,
    bucket: asset.bucket,
    objectPath: asset.objectPath,
    contentType: asset.contentType,
    width: asset.width,
    height: asset.height,
    sizeBytes: asset.sizeBytes,
    sha256: asset.sha256
  }));
}

export function createGeneratedOutputStorageTarget(input: {
  ownerId: string;
  jobId: string;
  attemptId: string;
  stepId?: string;
  contentType: GeneratedOutputArtifact["contentType"];
  developmentOnly?: boolean;
}) {
  const bucket = input.developmentOnly && isLocalGenerationWorkerEnabled()
    ? optionalEnv("GENERATION_LOCAL_OUTPUT_BUCKET") ?? "local-dev-generated-output"
    : requiredEnv("GCS_OUTPUT_BUCKET");

  return {
    bucket,
    objectPath: buildGeneratedOutputObjectPath(input)
  };
}

export async function registerGeneratedOutput(input: {
  ownerId: string;
  jobId: string;
  attemptId: string;
  stepId?: string;
  artifactRole?: "intermediate" | "final";
  artifact: GeneratedOutputArtifact;
  session?: ClientSession;
}) {
  const assets = await mongoCollection<AssetDocument>(collectionNames.assets);
  const now = new Date();
  const asset: AssetDocument = {
    ...createGeneratedOutputAssetDraft(input),
    createdAt: now
  };
  const result = await assets.updateOne(
    {
      _id: asset._id,
      ownerId: input.ownerId,
      generationJobId: input.jobId
    },
    { $setOnInsert: asset },
    { upsert: true, session: input.session }
  );

  if (result.upsertedCount === 1) {
    return {
      asset: toAssetDTO(asset),
      document: asset,
      inserted: true
    };
  }

  const existing = await assets.findOne(
    {
      _id: asset._id,
      ownerId: input.ownerId,
      generationJobId: input.jobId,
      deletedAt: { $exists: false }
    },
    { session: input.session }
  );

  if (!existing) {
    throw validationFailed("Generated output asset could not be registered.");
  }

  return {
    asset: toAssetDTO(existing),
    document: existing,
    inserted: false
  };
}

export async function signAssetDownload(ownerId: string, assetId: string) {
  const assets = await mongoCollection<AssetDocument>(collectionNames.assets);
  const asset = await assets.findOne({
    _id: assetId,
    ownerId,
    deletedAt: { $exists: false }
  });

  if (!asset) {
    throw notFound("Asset not found.");
  }

  if (asset.kind === "USER_UPLOAD" && asset.uploadState !== "COMPLETED") {
    throw validationFailed("Upload has not completed yet.");
  }

  const signed = await createSignedDownloadUrl({
    bucket: asset.bucket,
    objectPath: asset.objectPath
  });

  return {
    asset: toAssetDTO(asset),
    download: signed
  };
}
