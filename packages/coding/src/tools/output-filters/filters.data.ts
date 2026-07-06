import type { LineFilterRule } from './declarative.js';

export const BUILT_IN_LINE_FILTERS: readonly LineFilterRule[] = [
  {
    id: 'package-manager-progress',
    commandPattern: /\b(?:npm|pnpm|yarn|pip3?|uv|poetry)\s+(?:install|add|update|sync|build)\b/i,
    contentPattern: /(?:^|\n)(?:Progress:|Resolving:|Fetching:|Linking:|Downloading|Installing collected packages|\s*[\u2801-\u28ff]\s+)/i,
    filterStderr: true,
    stripLinesMatching: [
      /^\s*Progress:\s+/i,
      /^\s*(?:Resolving|Fetching|Linking|Downloading|Installing collected packages)\b/i,
      /^\s*[\u2801-\u28ff]\s+/u,
      /^\s*\d{1,3}%\s*(?:\[[^\]]+\])?/,
    ],
    maxLines: 120,
    headLines: 40,
    tailLines: 80,
  },
  {
    id: 'docker-progress',
    commandPattern: /\bdocker\s+(?:build|pull|push|compose)\b/i,
    contentPattern: /(?:^|\n)#\d+\s+(?:\[|CACHED|DONE|transferring|extracting|pulling)/i,
    filterStderr: true,
    stripLinesMatching: [
      /^#\d+\s+\[[^\]]+\]\s+(?:CACHED|DONE(?:\s+\d+\.\d+s)?|\d+\.\d+s)$/i,
      /^#\d+\s+(?:transferring|extracting|pulling|pushing|downloading)\b/i,
      /^[a-f0-9]+:\s+(?:Pulling fs layer|Downloading|Extracting|Verifying Checksum|Download complete|Pull complete)$/i,
    ],
    maxLines: 120,
    headLines: 40,
    tailLines: 80,
  },
  {
    id: 'infra-cli-progress',
    commandPattern: /\b(?:kubectl|aws|terraform|ansible-playbook)\b/i,
    contentPattern: /(?:^|\n)(?:Still (?:creating|modifying|destroying)|download:|upload:|\s*ok: \[|\s*changed: \[)/i,
    filterStderr: true,
    stripLinesMatching: [
      /^\s*Still (?:creating|modifying|destroying)\b/i,
      /^(?:download|upload):\s+/i,
      /^\s*(?:ok|changed|skipping): \[[^\]]+\]$/i,
    ],
    maxLines: 160,
    headLines: 60,
    tailLines: 100,
  },
];
