export interface CollapsedLines<T> {
  shown: T[];
  /** How many lines the collapse holds back; 0 once expanded or when nothing was clipped. */
  hidden: number;
}

/**
 * The first `limit` lines until expanded. Head-only on purpose: a card that
 * shows the tail (a running command) keeps its own slice and reports the
 * count it hid.
 */
export function collapseLines<T>(lines: readonly T[], limit: number, expanded: boolean): CollapsedLines<T> {
  if (expanded || lines.length <= limit) return { shown: [...lines], hidden: 0 };
  return { shown: lines.slice(0, limit), hidden: lines.length - limit };
}
