import { readFile, stat } from "node:fs/promises";
import path from "node:path";

const IMAGE_MEDIA_TYPES: Record<string, string> = {
  ".gif": "image/gif",
  ".jpeg": "image/jpeg",
  ".jpg": "image/jpeg",
  ".png": "image/png",
  ".webp": "image/webp",
};

export const MISSING_IMAGE_PLACEHOLDER =
  "[Historical image unavailable: the local attachment file is missing.]";
export const UNSUPPORTED_TOOL_RESULT_IMAGE_PLACEHOLDER =
  "[Image content omitted: this provider does not support inline images in tool results.]";

export async function isImageFileMissing(filePath: string): Promise<boolean> {
  try {
    await stat(filePath);
    return false;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    return code === "ENOENT" || code === "ENOTDIR";
  }
}

export function resolveImageMediaType(
  filePath: string,
  fallback?: string,
): string {
  return (
    fallback ??
    IMAGE_MEDIA_TYPES[path.extname(filePath).toLowerCase()] ??
    "image/png"
  );
}

export async function readImageFileAsBase64(filePath: string): Promise<string> {
  const content = await readFile(filePath);
  return content.toString("base64");
}

export async function readImageFileAsBase64IfAvailable(
  filePath: string,
): Promise<string | undefined> {
  try {
    return await readImageFileAsBase64(filePath);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "ENOTDIR") return undefined;
    throw err;
  }
}

export async function buildImageDataUrl(
  filePath: string,
  mediaType?: string,
): Promise<string> {
  const resolvedMediaType = resolveImageMediaType(filePath, mediaType);
  const encoded = await readImageFileAsBase64(filePath);
  return `data:${resolvedMediaType};base64,${encoded}`;
}

export async function buildImageDataUrlIfAvailable(
  filePath: string,
  mediaType?: string,
): Promise<string | undefined> {
  const encoded = await readImageFileAsBase64IfAvailable(filePath);
  if (encoded === undefined) return undefined;
  return `data:${resolveImageMediaType(filePath, mediaType)};base64,${encoded}`;
}
