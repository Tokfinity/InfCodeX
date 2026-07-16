export type KodaXImageMediaType =
  | 'image/png'
  | 'image/jpeg'
  | 'image/webp'
  | 'image/gif';

export type KodaXVideoMediaType =
  | 'video/mp4'
  | 'video/mpeg'
  | 'video/quicktime'
  | 'video/x-msvideo'
  | 'video/x-flv'
  | 'video/webm'
  | 'video/x-ms-wmv'
  | 'video/3gpp';

export type KodaXInputArtifactSource =
  | 'user-inline'
  | 'clipboard'
  | 'drag-drop'
  | 'file-picker';

export interface KodaXImageInputArtifact {
  readonly kind: 'image';
  readonly path: string;
  readonly mediaType?: KodaXImageMediaType;
  readonly source?: KodaXInputArtifactSource;
  readonly description?: string;
}

export interface KodaXFileInputArtifact {
  readonly kind: 'file';
  readonly path: string;
  readonly mediaType?: string;
  readonly mimeType?: string;
  readonly name?: string;
  readonly source?: KodaXInputArtifactSource;
  readonly description?: string;
}

export interface KodaXVideoInputArtifact {
  readonly kind: 'video';
  readonly path: string;
  readonly mediaType: KodaXVideoMediaType;
  readonly name?: string;
  readonly source?: KodaXInputArtifactSource;
  readonly description?: string;
}

export type KodaXInputArtifact =
  | KodaXImageInputArtifact
  | KodaXFileInputArtifact
  | KodaXVideoInputArtifact;
