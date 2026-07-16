import type { KodaXToolExecutionContext } from '../../types.js';

export type Lossiness = 'none' | 'tail' | 'whole';

export interface FilterResult {
  stdout: string;
  stderr: string;
  lossiness: Lossiness;
  note?: string;
}

export interface BashOutputFilterInput extends FilterResult {
  command: string;
}

export type BashOutputFilter = (input: BashOutputFilterInput) => FilterResult;

export type PersistRawOutput = (
  toolName: string,
  content: string,
  ctx: KodaXToolExecutionContext,
) => Promise<string>;

export interface FilterBashOutputBodiesInput {
  command: string;
  stdout: string;
  stderr: string;
  ctx: KodaXToolExecutionContext;
  filters?: readonly BashOutputFilter[];
  persist?: PersistRawOutput;
}

export interface FinalizeFilteredBashOutputInput {
  raw: FilterResult;
  filtered: FilterResult;
  ctx: KodaXToolExecutionContext;
  persist: PersistRawOutput;
}
