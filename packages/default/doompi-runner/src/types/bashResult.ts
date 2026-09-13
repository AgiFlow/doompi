export interface ToolResult {
  content: Array<{ type: 'text'; text: string }>;
  details: Record<string, unknown>;
  /** Tools this result makes available from here on in the transcript. */
  addedToolNames?: string[];
}
export interface TruncatedOutput {
  text: string;
  truncated: boolean;
  /** Lines returned, which is what the model actually received. */
  outputLines: number;
}
export interface LogSummary {
  tail: string;
  bytes: number;
  lines: number;
  tailLines: number;
}
export interface ErrorLineScanner {
  push(line: string): void;
  entries(): SalvagedError[];
}
export interface ResultBudget {
  readonly maxBytes?: number;
  readonly maxLines?: number;
  readonly maxTokens?: number;
}
export interface SalvagedError {
  /** Distinct exact lines sharing one shape, in the order first seen. */
  readonly variants: readonly string[];
  /** Total occurrences across every variant. */
  readonly count: number;
}
export interface Excerpt {
  /** Head, elision marker, and tail already composed for display. */
  readonly text: string;
  /** Lines actually shown, excluding the marker. */
  readonly lines: number;
  readonly truncated: boolean;
  readonly elidedLines: number;
}
export type LogSummarizer = (path: string, maxLines: number, maxBytes: number, maxTokens: number) => LogSummary;
