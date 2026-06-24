import type { KodaXInputArtifact } from '../types.js';
import { KodaXMediaError } from './errors.js';
import {
  KODAX_IMAGE_MEDIA_TYPES,
  getModelInputCapabilities,
} from './capabilities.js';

export interface ValidateInputArtifactsOptions {
  readonly provider: string;
  readonly model?: string;
}

interface ArtifactLike {
  readonly kind?: unknown;
  readonly mediaType?: unknown;
}

function asArtifactLike(artifact: KodaXInputArtifact): ArtifactLike {
  return artifact;
}

function isKnownImageMediaType(mediaType: string): boolean {
  return KODAX_IMAGE_MEDIA_TYPES.includes(mediaType as typeof KODAX_IMAGE_MEDIA_TYPES[number]);
}

export function validateInputArtifactsForModel(
  artifacts: readonly KodaXInputArtifact[],
  options: ValidateInputArtifactsOptions,
): void {
  if (artifacts.length === 0) return;

  const capabilities = getModelInputCapabilities(options);
  for (const artifact of artifacts) {
    const candidate = asArtifactLike(artifact);
    if (candidate.kind === 'image') {
      if (!capabilities.image.nativeSupported || !capabilities.image.sdkSupported) {
        throw new KodaXMediaError(
          'MODEL_INPUT_UNSUPPORTED',
          `Provider/model cannot consume image artifacts: ${options.provider}${options.model ? `/${options.model}` : ''}.`,
          { detail: capabilities.image.status },
        );
      }
      if (
        typeof candidate.mediaType === 'string'
        && !isKnownImageMediaType(candidate.mediaType)
      ) {
        throw new KodaXMediaError(
          'UNSUPPORTED_MEDIA_TYPE',
          `Unsupported image media type: ${candidate.mediaType}.`,
        );
      }
      continue;
    }

    if (candidate.kind === 'video') {
      throw new KodaXMediaError(
        'MODEL_INPUT_UNSUPPORTED',
        'Video artifacts are not wired into the KodaX v0.7.56 runtime send path.',
        { detail: capabilities.video.status },
      );
    }

    throw new KodaXMediaError(
      'MODEL_INPUT_UNSUPPORTED',
      `Unsupported input artifact kind: ${String(candidate.kind)}.`,
    );
  }
}
