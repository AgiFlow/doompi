import type { GrepParams } from '../../schemas/grepTool';
import type { GrepResult } from '../grepTool';

/** One ripgrep search, as a host asks for it. */
export interface RipgrepRequest {
  readonly params: GrepParams;
  readonly cwd: string;
  readonly signal: AbortSignal | undefined;
}

/** The search result, in the shape the tagging service consumes. */
export type RipgrepResult = GrepResult;
