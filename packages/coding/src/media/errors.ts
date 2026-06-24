export type KodaXMediaErrorCode =
  | 'CLIPBOARD_EMPTY'
  | 'CLIPBOARD_IMAGE_UNAVAILABLE'
  | 'UNSUPPORTED_PLATFORM'
  | 'IMAGE_DECODE_FAILED'
  | 'IMAGE_TOO_LARGE'
  | 'UNSUPPORTED_MEDIA_TYPE'
  | 'MODEL_INPUT_UNSUPPORTED'
  | 'FILE_ACCESS_DENIED';

export interface KodaXMediaErrorOptions {
  readonly detail?: string;
  readonly cause?: unknown;
}

export class KodaXMediaError extends Error {
  readonly code: KodaXMediaErrorCode;
  readonly detail?: string;
  override readonly cause?: unknown;

  constructor(
    code: KodaXMediaErrorCode,
    message: string,
    options: KodaXMediaErrorOptions = {},
  ) {
    super(message);
    this.name = 'KodaXMediaError';
    this.code = code;
    this.detail = options.detail;
    this.cause = options.cause;
  }
}

export class ImageResizeError extends KodaXMediaError {
  constructor(
    message: string,
    options: KodaXMediaErrorOptions & { readonly code?: KodaXMediaErrorCode } = {},
  ) {
    super(options.code ?? 'IMAGE_TOO_LARGE', message, options);
    this.name = 'ImageResizeError';
  }
}
