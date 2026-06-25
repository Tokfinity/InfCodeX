import type { KodaXInputArtifact } from '../types.js';
import { KodaXMediaError } from './errors.js';
import {
  KODAX_IMAGE_MEDIA_TYPES,
  KODAX_VIDEO_MEDIA_TYPES,
  getModelInputCapabilities,
  type KodaXModalityInputCapability,
} from './capabilities.js';

export interface ValidateInputArtifactsOptions {
  readonly provider: string;
  readonly model?: string;
}

interface ArtifactLike {
  readonly kind?: unknown;
  readonly mediaType?: unknown;
  readonly mimeType?: unknown;
}

function asArtifactLike(artifact: KodaXInputArtifact): ArtifactLike {
  return artifact;
}

function isKnownImageMediaType(mediaType: string): boolean {
  return KODAX_IMAGE_MEDIA_TYPES.includes(mediaType as typeof KODAX_IMAGE_MEDIA_TYPES[number]);
}

function isKnownVideoMediaType(mediaType: string): boolean {
  return KODAX_VIDEO_MEDIA_TYPES.includes(mediaType as typeof KODAX_VIDEO_MEDIA_TYPES[number]);
}

function routeLabel(options: ValidateInputArtifactsOptions): string {
  return `${options.provider}${options.model ? `/${options.model}` : ''}`;
}

function capabilityDetail(
  capability: KodaXModalityInputCapability<string>,
): string {
  return capability.reason
    ? `${capability.status}: ${capability.reason}`
    : capability.status;
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
          `Provider/model cannot consume image artifacts: ${routeLabel(options)}.`,
          { detail: capabilityDetail(capabilities.image) },
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
      if (typeof candidate.mediaType !== 'string' || !isKnownVideoMediaType(candidate.mediaType)) {
        throw new KodaXMediaError(
          'UNSUPPORTED_MEDIA_TYPE',
          `Unsupported video media type: ${String(candidate.mediaType)}.`,
          { detail: `Supported video media types: ${KODAX_VIDEO_MEDIA_TYPES.join(', ')}` },
        );
      }
      throw new KodaXMediaError(
        'MODEL_INPUT_UNSUPPORTED',
        `Provider/model cannot consume video artifacts through this SDK runtime: ${routeLabel(options)}.`,
        { detail: capabilityDetail(capabilities.video) },
      );
    }

    if (candidate.kind === 'file') {
      if (
        typeof candidate.mediaType === 'string'
        && typeof candidate.mimeType === 'string'
        && candidate.mediaType !== candidate.mimeType
      ) {
        throw new KodaXMediaError(
          'UNSUPPORTED_MEDIA_TYPE',
          `File artifact mediaType and mimeType disagree: ${candidate.mediaType} != ${candidate.mimeType}.`,
        );
      }
      throw new KodaXMediaError(
        'MODEL_INPUT_UNSUPPORTED',
        `Provider/model cannot consume file artifacts through this SDK runtime: ${routeLabel(options)}.`,
        { detail: capabilityDetail(capabilities.file) },
      );
    }

    throw new KodaXMediaError(
      'MODEL_INPUT_UNSUPPORTED',
      `Unsupported input artifact kind: ${String(candidate.kind)}.`,
    );
  }
}
