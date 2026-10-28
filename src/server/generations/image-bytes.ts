import sharp from "sharp";

export async function inspectImageBytes(bytes: Buffer, maxPixels = 4096 * 4096) {
  if (!bytes.length || bytes.length > 100 * 1024 * 1024) throw new Error("Image byte size is invalid.");
  const decoder = sharp(bytes, { limitInputPixels: maxPixels, failOn: "warning" });
  const metadata = await decoder.metadata();
  if (!metadata.width || !metadata.height || !["png", "jpeg", "webp"].includes(metadata.format ?? "") || (metadata.pages ?? 1) !== 1) throw new Error("A valid single image is required.");
  await decoder.raw().toBuffer(); // Header parsing alone does not detect truncated/corrupt image data.
  return { width: metadata.width, height: metadata.height, contentType: `image/${metadata.format}` as "image/png" | "image/jpeg" | "image/webp" };
}

export function decodeProviderImage(base64: string) {
  if (base64.length > 140 * 1024 * 1024 || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(base64)) throw new Error("Invalid encoded image.");
  return Buffer.from(base64, "base64");
}
