import path from 'node:path';
import type {
  KodaXImageInputArtifact,
  KodaXImageMediaType,
  KodaXInputArtifactSource,
} from '../types.js';

const IMAGE_MEDIA_TYPES_BY_EXT: Readonly<Record<string, KodaXImageMediaType>> = {
  '.gif': 'image/gif',
  '.jpeg': 'image/jpeg',
  '.jpg': 'image/jpeg',
  '.png': 'image/png',
  '.webp': 'image/webp',
};

export interface CreateImageArtifactFromPathOptions {
  readonly mediaType?: KodaXImageMediaType;
  readonly source?: KodaXInputArtifactSource;
  readonly description?: string;
}

export function inferImageMediaType(filePath: string): KodaXImageMediaType | undefined {
  return IMAGE_MEDIA_TYPES_BY_EXT[path.extname(filePath).toLowerCase()];
}

export function createImageArtifactFromPath(
  filePath: string,
  options: CreateImageArtifactFromPathOptions = {},
): KodaXImageInputArtifact {
  const mediaType = options.mediaType ?? inferImageMediaType(filePath);
  return {
    kind: 'image',
    path: filePath,
    ...(mediaType ? { mediaType } : {}),
    ...(options.source ? { source: options.source } : {}),
    ...(options.description ? { description: options.description } : {}),
  };
}
