import {
  KODAX_PROVIDER_SNAPSHOTS,
  normalizeCapabilityProfile,
} from '@kodax-ai/llm';
import type {
  KodaXImageMediaType,
} from '../types.js';

export type KodaXVideoMediaType =
  | 'video/mp4'
  | 'video/mpeg'
  | 'video/quicktime'
  | 'video/x-msvideo'
  | 'video/x-flv'
  | 'video/webm'
  | 'video/x-ms-wmv'
  | 'video/3gpp';

export type KodaXInputCapabilityStatus =
  | 'supported'
  | 'provider-native-unwired'
  | 'unsupported';

export interface KodaXModalityInputCapability<TMediaType extends string> {
  readonly nativeSupported: boolean;
  readonly sdkSupported: boolean;
  readonly status: KodaXInputCapabilityStatus;
  readonly mediaTypes: readonly TMediaType[];
  readonly nativeMediaTypes?: readonly TMediaType[];
  readonly maxBytes?: number;
  readonly maxCount?: number;
  readonly reason?: string;
}

export interface ModelInputCapabilities {
  readonly text: true;
  readonly image: KodaXModalityInputCapability<KodaXImageMediaType>;
  readonly video: KodaXModalityInputCapability<KodaXVideoMediaType>;
  readonly file: KodaXModalityInputCapability<string>;
}

export interface GetModelInputCapabilitiesInput {
  readonly provider: string;
  readonly model?: string;
}

export const KODAX_IMAGE_MEDIA_TYPES: readonly KodaXImageMediaType[] = [
  'image/png',
  'image/jpeg',
  'image/webp',
  'image/gif',
];

export const KODAX_VIDEO_MEDIA_TYPES: readonly KodaXVideoMediaType[] = [
  'video/mp4',
  'video/mpeg',
  'video/quicktime',
  'video/x-msvideo',
  'video/x-flv',
  'video/webm',
  'video/x-ms-wmv',
  'video/3gpp',
];

const OFFICIAL_IMAGE_PROVIDERS = new Set(['anthropic', 'openai']);
const SOURCE_BACKED_NATIVE_MEDIA_ROUTES = new Set([
  'kimi-code/kimi-for-coding',
  'kimi/kimi-k2.5',
  'kimi/kimi-k2.6',
  'kimi/kimi-k2.7-code',
  'minimax-coding/minimax-m3',
  'minimax/minimax-m3',
  'mimo-coding/mimo-v2.5',
  'mimo/mimo-v2.5',
]);

function unsupported<TMediaType extends string>(
  reason: string,
): KodaXModalityInputCapability<TMediaType> {
  return {
    nativeSupported: false,
    sdkSupported: false,
    status: 'unsupported',
    mediaTypes: [],
    reason,
  };
}

function supportedImage(
  reason: string,
): KodaXModalityInputCapability<KodaXImageMediaType> {
  return {
    nativeSupported: true,
    sdkSupported: true,
    status: 'supported',
    mediaTypes: KODAX_IMAGE_MEDIA_TYPES,
    reason,
  };
}

function nativeVideoUnwired(
  reason: string,
): KodaXModalityInputCapability<KodaXVideoMediaType> {
  return {
    nativeSupported: true,
    sdkSupported: false,
    status: 'provider-native-unwired',
    mediaTypes: [],
    nativeMediaTypes: KODAX_VIDEO_MEDIA_TYPES,
    reason,
  };
}

function normalizeProvider(provider: string): string {
  return provider.trim().toLowerCase();
}

function resolveProviderDefaultModel(provider: string): string | undefined {
  const snapshots: Record<string, { readonly model: string }> = KODAX_PROVIDER_SNAPSHOTS;
  return snapshots[provider]?.model;
}

function normalizeModel(provider: string, model: string | undefined): string | undefined {
  if (!model) return undefined;
  const normalized = model.trim().toLowerCase();
  if (provider === 'kimi') {
    if (normalized === 'k2.5') return 'kimi-k2.5';
    if (normalized === 'k2.6') return 'kimi-k2.6';
    if (normalized === 'k2.7-code') return 'kimi-k2.7-code';
  }
  if (provider === 'minimax-coding' || provider === 'minimax') {
    if (normalized === 'minimax-m3') return 'minimax-m3';
  }
  return normalized;
}

function hasOfficialImageSupport(provider: string): boolean {
  if (!OFFICIAL_IMAGE_PROVIDERS.has(provider)) return false;
  const snapshot = KODAX_PROVIDER_SNAPSHOTS[provider as keyof typeof KODAX_PROVIDER_SNAPSHOTS];
  if (!snapshot) return false;
  return normalizeCapabilityProfile(snapshot.capabilityProfile).multimodalSupport !== 'none';
}

function hasSourceBackedNativeMedia(provider: string, model: string | undefined): boolean {
  const normalizedModel = normalizeModel(provider, model);
  if (!normalizedModel) return false;
  const route = `${provider}/${normalizedModel}`;
  return SOURCE_BACKED_NATIVE_MEDIA_ROUTES.has(route);
}

export function getModelInputCapabilities(
  input: GetModelInputCapabilitiesInput,
): ModelInputCapabilities {
  const provider = normalizeProvider(input.provider);
  const model = input.model?.trim() || resolveProviderDefaultModel(provider);
  const imageSupported = hasOfficialImageSupport(provider)
    || hasSourceBackedNativeMedia(provider, model);
  const videoNative = hasSourceBackedNativeMedia(provider, model);

  return {
    text: true,
    image: imageSupported
      ? supportedImage('Model route supports KodaX image input.')
      : unsupported('No verified KodaX image-input route for this provider/model.'),
    video: videoNative
      ? nativeVideoUnwired('Model route is native-video capable, but KodaX video sending is not wired in v0.7.56.')
      : unsupported('No verified native video route for this provider/model.'),
    file: unsupported('File artifacts are not part of the v0.7.56 media send path.'),
  };
}
