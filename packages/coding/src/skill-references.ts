export interface InlineSkillReference {
  readonly name: string;
  readonly raw: string;
  readonly start: number;
  readonly end: number;
}

export function parseInlineSkillReferences(input: string): readonly InlineSkillReference[] {
  if (!input.trim()) return [];

  const matches: InlineSkillReference[] = [];
  const regex = /(^|\s)\/skill:([\w](?:[\w.\-:]*[\w])?)/g;
  let match: RegExpExecArray | null;
  while ((match = regex.exec(input)) !== null) {
    const lead = match[1] ?? '';
    const name = match[2] ?? '';
    if (!name) continue;
    const start = match.index + lead.length;
    const raw = `/skill:${name}`;
    matches.push({ name, raw, start, end: start + raw.length });
  }
  return matches;
}

export function parseBareInlineSlashReferences(input: string): readonly InlineSkillReference[] {
  if (!input.trim()) return [];

  const matches: InlineSkillReference[] = [];
  const regex = /(^|\s)\/(?!skill:)([\w](?:[\w.\-:]*[\w])?)/g;
  let match: RegExpExecArray | null;
  while ((match = regex.exec(input)) !== null) {
    const lead = match[1] ?? '';
    const name = match[2] ?? '';
    if (!name) continue;
    const start = match.index + lead.length;
    const raw = `/${name}`;
    matches.push({ name, raw, start, end: start + raw.length });
  }
  return matches;
}

export function uniqueInlineSkillNames(input: string): readonly string[] {
  return Array.from(new Set(parseInlineSkillReferences(input).map((ref) => ref.name)));
}

export function uniqueBareInlineSlashNames(input: string): readonly string[] {
  return Array.from(new Set(parseBareInlineSlashReferences(input).map((ref) => ref.name)));
}
