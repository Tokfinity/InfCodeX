import path from 'node:path';
import type {
  KodaXFileInputArtifact,
  KodaXImageInputArtifact,
  KodaXImageMediaType,
  KodaXInputArtifactSource,
  KodaXVideoInputArtifact,
  KodaXVideoMediaType,
} from '../types.js';
import { KodaXMediaError } from './errors.js';

const IMAGE_MEDIA_TYPES_BY_EXT: Readonly<Record<string, KodaXImageMediaType>> = {
  '.gif': 'image/gif',
  '.jpeg': 'image/jpeg',
  '.jpg': 'image/jpeg',
  '.png': 'image/png',
  '.webp': 'image/webp',
};

const VIDEO_MEDIA_TYPES_BY_EXT: Readonly<Record<string, KodaXVideoMediaType>> = {
  '.3gp': 'video/3gpp',
  '.3gpp': 'video/3gpp',
  '.avi': 'video/x-msvideo',
  '.flv': 'video/x-flv',
  '.mov': 'video/quicktime',
  '.mp4': 'video/mp4',
  '.mpeg': 'video/mpeg',
  '.mpg': 'video/mpeg',
  '.webm': 'video/webm',
  '.wmv': 'video/x-ms-wmv',
};

export interface CreateImageArtifactFromPathOptions {
  readonly mediaType?: KodaXImageMediaType;
  readonly source?: KodaXInputArtifactSource;
  readonly description?: string;
}

export interface CreateFileArtifactFromPathOptions {
  readonly mediaType?: string;
  readonly mimeType?: string;
  readonly name?: string;
  readonly source?: KodaXInputArtifactSource;
  readonly description?: string;
}

export interface CreateVideoArtifactFromPathOptions {
  readonly mediaType?: KodaXVideoMediaType;
  readonly name?: string;
  readonly source?: KodaXInputArtifactSource;
  readonly description?: string;
}

export function inferImageMediaType(filePath: string): KodaXImageMediaType | undefined {
  return IMAGE_MEDIA_TYPES_BY_EXT[path.extname(filePath).toLowerCase()];
}

export function inferVideoMediaType(filePath: string): KodaXVideoMediaType | undefined {
  return VIDEO_MEDIA_TYPES_BY_EXT[path.extname(filePath).toLowerCase()];
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

export function createFileArtifactFromPath(
  filePath: string,
  options: CreateFileArtifactFromPathOptions = {},
): KodaXFileInputArtifact {
  if (
    options.mediaType !== undefined
    && options.mimeType !== undefined
    && options.mediaType !== options.mimeType
  ) {
    throw new KodaXMediaError(
      'UNSUPPORTED_MEDIA_TYPE',
      `File artifact mediaType and mimeType disagree: ${options.mediaType} != ${options.mimeType}.`,
    );
  }
  return {
    kind: 'file',
    path: filePath,
    ...(options.mediaType ? { mediaType: options.mediaType } : {}),
    ...(options.mimeType ? { mimeType: options.mimeType } : {}),
    ...(options.name ? { name: options.name } : {}),
    ...(options.source ? { source: options.source } : {}),
    ...(options.description ? { description: options.description } : {}),
  };
}

export function createVideoArtifactFromPath(
  filePath: string,
  options: CreateVideoArtifactFromPathOptions = {},
): KodaXVideoInputArtifact {
  const mediaType = options.mediaType ?? inferVideoMediaType(filePath);
  if (!mediaType) {
    throw new KodaXMediaError(
      'UNSUPPORTED_MEDIA_TYPE',
      `Cannot infer video media type from path: ${filePath}.`,
    );
  }
  return {
    kind: 'video',
    path: filePath,
    mediaType,
    ...(options.name ? { name: options.name } : {}),
    ...(options.source ? { source: options.source } : {}),
    ...(options.description ? { description: options.description } : {}),
  };
}
