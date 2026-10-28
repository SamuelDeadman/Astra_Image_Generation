import "server-only";

import crypto from "node:crypto";
import path from "node:path";
import { Storage } from "@google-cloud/storage";
import { configurationRequired, validationFailed } from "@/server/errors";
import { missingEnv, requiredEnv } from "@/server/env";

const allowedImageTypes = new Set(["image/png", "image/jpeg", "image/webp"]);
const maxUploadBytes = 20 * 1024 * 1024;
let storageClient: Storage | undefined;

function getStorageClient() {
  storageClient ??= new Storage();
  return storageClient;
}

export function assertStorageConfigured() {
  const missing = missingEnv(["GCS_INPUT_BUCKET", "GCS_OUTPUT_BUCKET"]);

  if (missing.length > 0) {
    throw configurationRequired("Cloud Storage buckets are not configured.", { missing });
  }
}

export function validateImageUpload(input: { contentType: string; sizeBytes: number; filename: string }) {
  if (!allowedImageTypes.has(input.contentType)) {
    throw validationFailed("Unsupported image content type.", { allowed: Array.from(allowedImageTypes) });
  }

  if (input.sizeBytes < 1 || input.sizeBytes > maxUploadBytes) {
    throw validationFailed("Image upload size is outside the allowed range.", { maxUploadBytes });
  }

  const extension = path.extname(input.filename).toLowerCase();
  if (![".png", ".jpg", ".jpeg", ".webp"].includes(extension)) {
    throw validationFailed("Image filename must use a supported extension.");
  }
}

export function buildUserObjectPath(input: { ownerId: string; filename: string; prefix: "uploads" | "outputs" }) {
  const extension = path.extname(input.filename).toLowerCase();
  const randomName = crypto.randomBytes(18).toString("hex");
  const ownerHash = crypto.createHash("sha256").update(input.ownerId).digest("hex").slice(0, 20);
  return `${input.prefix}/${ownerHash}/${randomName}${extension}`;
}

export async function createSignedUploadUrl(input: {
  ownerId: string;
  filename: string;
  contentType: string;
  sizeBytes: number;
}) {
  assertStorageConfigured();
  validateImageUpload(input);

  const bucket = requiredEnv("GCS_INPUT_BUCKET");
  const objectPath = buildUserObjectPath({ ownerId: input.ownerId, filename: input.filename, prefix: "uploads" });
  const [url] = await getStorageClient()
    .bucket(bucket)
    .file(objectPath)
    .getSignedUrl({
      version: "v4",
      action: "write",
      expires: Date.now() + 10 * 60 * 1000,
      contentType: input.contentType
    });

  return { bucket, objectPath, url, expiresAt: new Date(Date.now() + 10 * 60 * 1000).toISOString() };
}

export async function createSignedDownloadUrl(input: { bucket: string; objectPath: string }) {
  assertStorageConfigured();

  const [url] = await getStorageClient()
    .bucket(input.bucket)
    .file(input.objectPath)
    .getSignedUrl({
      version: "v4",
      action: "read",
      expires: Date.now() + 5 * 60 * 1000
    });

  return { url, expiresAt: new Date(Date.now() + 5 * 60 * 1000).toISOString() };
}

export async function getStorageObjectMetadata(input: { bucket: string; objectPath: string }) {
  assertStorageConfigured();

  const file = getStorageClient().bucket(input.bucket).file(input.objectPath);
  const [exists] = await file.exists();

  if (!exists) {
    return null;
  }

  const [metadata] = await file.getMetadata();

  return {
    contentType: metadata.contentType,
    sizeBytes: metadata.size ? Number(metadata.size) : undefined,
    updatedAt: metadata.updated
  };
}

export async function writePrivateObject(input: {
  bucket: string;
  objectPath: string;
  contentType: string;
  data: Buffer;
}) {
  const file = getStorageClient().bucket(input.bucket).file(input.objectPath);
  await file.save(input.data, {
    resumable: false,
    contentType: input.contentType,
    metadata: {
      cacheControl: "private, max-age=0, no-store"
    }
  });

  return {
    sizeBytes: input.data.byteLength,
    sha256: crypto.createHash("sha256").update(input.data).digest("hex")
  };
}

export async function readPrivateObject(input: { bucket: string; objectPath: string }) {
  assertStorageConfigured();

  const [data] = await getStorageClient().bucket(input.bucket).file(input.objectPath).download();
  return data;
}
