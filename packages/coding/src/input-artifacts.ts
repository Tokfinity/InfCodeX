import type { QueuedInputArtifact } from '@kodax-ai/agent';
import type {
  KodaXImageMediaType,
  KodaXInputArtifact,
  KodaXInputArtifactSource,
  KodaXVideoMediaType,
} from './types.js';

// CAP-009 (`buildPromptMessageContent`) extracted to
// `agent-runtime/prompt-content.ts` in FEATURE_100 P2; re-export below to
// preserve the public API path.
export { buildPromptMessageContent } from './agent-runtime/prompt-content.js';

/** Convert the canonical Agent queue artifact shape into coding input artifacts. */
export function toKodaXInputArtifacts(
  inputArtifacts: readonly QueuedInputArtifact[] | undefined,
): readonly KodaXInputArtifact[] | undefined {
  if (!inputArtifacts || inputArtifacts.length === 0) return undefined;

  return inputArtifacts.map((artifact): KodaXInputArtifact => {
    if (artifact.kind === 'image') {
      return {
        kind: 'image',
        path: artifact.path,
        ...(artifact.mediaType
          ? { mediaType: artifact.mediaType as KodaXImageMediaType }
          : {}),
        ...(artifact.source
          ? { source: artifact.source as KodaXInputArtifactSource }
          : {}),
        ...(artifact.description ? { description: artifact.description } : {}),
      };
    }

    if (artifact.kind === 'video') {
      return {
        kind: 'video',
        path: artifact.path,
        mediaType: artifact.mediaType as KodaXVideoMediaType,
        ...(artifact.name ? { name: artifact.name } : {}),
        ...(artifact.source
          ? { source: artifact.source as KodaXInputArtifactSource }
          : {}),
        ...(artifact.description ? { description: artifact.description } : {}),
      };
    }

    return {
      kind: 'file',
      path: artifact.path,
      ...(artifact.mediaType ? { mediaType: artifact.mediaType } : {}),
      ...(artifact.mimeType ? { mimeType: artifact.mimeType } : {}),
      ...(artifact.name ? { name: artifact.name } : {}),
      ...(artifact.source
        ? { source: artifact.source as KodaXInputArtifactSource }
        : {}),
      ...(artifact.description ? { description: artifact.description } : {}),
    };
  });
}

// CAP-046 (`extractPromptComparableText`, `extractComparableUserMessageText`)
// extracted to `agent-runtime/middleware/auto-resume.ts` in FEATURE_100 P2;
// re-export below so external consumers (round-boundary.ts, index.ts barrel)
// keep working unchanged.
export {
  extractPromptComparableText,
  extractComparableUserMessageText,
} from './agent-runtime/middleware/auto-resume.js';
