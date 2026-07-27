import { describe, expect, it } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import {
  buildImageDataUrlIfAvailable,
  isImageFileMissing,
  readImageFileAsBase64IfAvailable,
} from "./image-serialization.js";

describe("image serialization availability", () => {
  it("returns undefined only when the image path is missing", async () => {
    const cwd = await mkdtemp(
      path.join(tmpdir(), "kodax-image-serialization-"),
    );
    try {
      const missingPath = path.join(cwd, "missing.png");
      await expect(
        readImageFileAsBase64IfAvailable(missingPath),
      ).resolves.toBeUndefined();
      await expect(
        buildImageDataUrlIfAvailable(missingPath, "image/png"),
      ).resolves.toBeUndefined();
      await expect(isImageFileMissing(missingPath)).resolves.toBe(true);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it("preserves non-missing filesystem failures", async () => {
    const cwd = await mkdtemp(
      path.join(tmpdir(), "kodax-image-serialization-error-"),
    );
    try {
      await expect(readImageFileAsBase64IfAvailable(cwd)).rejects.toMatchObject(
        {
          code: "EISDIR",
        },
      );
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it("does not classify existing files or non-missing filesystem shapes as missing", async () => {
    const cwd = await mkdtemp(
      path.join(tmpdir(), "kodax-image-serialization-exists-"),
    );
    try {
      const imagePath = path.join(cwd, "image.png");
      await writeFile(imagePath, "bytes");
      await expect(isImageFileMissing(imagePath)).resolves.toBe(false);
      await expect(isImageFileMissing(cwd)).resolves.toBe(false);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });
});
