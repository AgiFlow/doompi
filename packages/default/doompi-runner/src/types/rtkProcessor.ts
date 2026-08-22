export type RtkFilter = 'cargo-test' | 'pytest' | 'git-diff' | 'grep' | 'go-test' | 'ruff-check';

export interface RtkProcessedOutput {
  readonly filter: RtkFilter;
  /** Leading excerpt of RTK stdout, empty when `output` already holds the start. */
  readonly head: string;
  /** Tail-capped RTK stdout. The raw log remains the authoritative complete output. */
  readonly output: string;
  readonly bytes: number;
  readonly lines: number;
}

export type RtkProcessResult =
  | { readonly kind: 'skipped' }
  | { readonly kind: 'processed'; readonly result: RtkProcessedOutput }
  | { readonly kind: 'fallback'; readonly warning: string };

export interface RtkProcessRequest {
  readonly command: string;
  readonly logPath: string;
}

export interface IRtkProcessor {
  process(request: RtkProcessRequest): Promise<RtkProcessResult>;
}

/** Raw-output fallback notices. Shared so the processor and its caller cannot drift. */
export const RTK_UNAVAILABLE_WARNING = 'Warning: RTK is unavailable; showing raw output.';
export const RTK_FAILED_WARNING = 'Warning: RTK processing failed; showing raw output.';
export const RTK_TIMEOUT_WARNING = 'Warning: RTK processing timed out; showing raw output.';
export const RTK_OVERSIZED_WARNING = 'Warning: RTK input exceeds 10 MiB; showing raw output.';
