/**
 * Wire and domain shapes for per-model system prompt guidance.
 *
 * Document values are `unknown` rather than `string` because a guidance file is
 * user-authored YAML: the parser cannot promise a string, so the fold narrows
 * each value instead of asserting one.
 */

/** Raw shape of one `.doom/model-guidance.yaml` document. */
export interface ModelGuidanceDocument {
  readonly modelGuidance?: Readonly<Record<string, unknown>>;
}

/** Model id to guidance text, after the global and repository documents are folded. */
export type ModelGuidanceMap = Readonly<Record<string, string>>;
