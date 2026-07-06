import { persistToolOutput } from '../truncate.js';
import { applyCompiledOutputFilters } from './compiled/index.js';
import { applyDeclarativeOutputFilters } from './declarative.js';
import { applyGenericOutputFilter } from './generic.js';
import { neverWorse } from './never-worse.js';
import type {
  BashOutputFilter,
  FilterBashOutputBodiesInput,
  FilterResult,
  FinalizeFilteredBashOutputInput,
} from './types.js';

const DEFAULT_FILTERS: readonly BashOutputFilter[] = [
  applyGenericOutputFilter,
  applyCompiledOutputFilters,
  applyDeclarativeOutputFilters,
];

export function renderBashBody(body: FilterResult): string {
  let text = body.stdout;
  if (body.stderr) {
    text += `${text ? '\n' : ''}[stderr]\n${body.stderr}`;
  }
  if (body.note) {
    text += `${text ? '\n' : ''}${body.note}`;
  }
  return text;
}

export async function finalizeFilteredBashOutput(
  input: FinalizeFilteredBashOutputInput,
): Promise<FilterResult> {
  const rawBody = renderBashBody(input.raw);
  let candidate = input.filtered;

  if (candidate.lossiness !== 'none') {
    const candidateBodyWithoutRecoveryHint = renderBashBody(candidate);
    if (neverWorse(rawBody, candidateBodyWithoutRecoveryHint) === rawBody) {
      return input.raw;
    }

    let outputPath: string;
    try {
      outputPath = await input.persist('bash-output-raw', rawBody, input.ctx);
    } catch {
      return input.raw;
    }
    candidate = {
      ...candidate,
      note: [
        candidate.note,
        `[Bash output compressed; full raw output saved to: ${outputPath}. Use read on that path if details are needed.]`,
      ].filter((line): line is string => Boolean(line)).join('\n'),
    };
  }

  const candidateBody = renderBashBody(candidate);
  return neverWorse(rawBody, candidateBody) === rawBody ? input.raw : candidate;
}

export async function filterBashOutputBodies(
  input: FilterBashOutputBodiesInput,
): Promise<FilterResult> {
  const raw: FilterResult = {
    stdout: input.stdout,
    stderr: input.stderr,
    lossiness: 'none',
  };
  const filters = input.filters ?? DEFAULT_FILTERS;
  let filtered = raw;
  try {
    for (const filter of filters) {
      filtered = filter({ ...filtered, command: input.command });
    }

    return await finalizeFilteredBashOutput({
      raw,
      filtered,
      ctx: input.ctx,
      persist: input.persist ?? persistToolOutput,
    });
  } catch {
    return raw;
  }
}
