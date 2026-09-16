/**
 * The arithmetic behind the charts, kept out of the components so it can be
 * tested as plain functions rather than through a render.
 *
 * There is no charting library in the cockpit bundle and the plugin import
 * allowlist would not admit one, so these are the primitives the SVG is drawn
 * from. They are deliberately small: a bar length and a tick set, nothing that
 * pretends to be a plotting engine.
 */

/** Bar length as a fraction of the track, guarding the all-zero series. */
export function barFraction(value: number, max: number): number {
  if (!Number.isFinite(value) || value <= 0) return 0;
  if (!Number.isFinite(max) || max <= 0) return 0;
  return Math.min(1, value / max);
}

/** The largest value in a series, or 0 for an empty one. */
export function seriesMax(values: readonly number[]): number {
  return values.reduce((highest, value) => (value > highest ? value : highest), 0);
}

/**
 * Compact token counts. Charts label axes and bars in a few characters, and a
 * raw nine-digit total makes every row the same illegible width.
 */
export function formatTokens(value: number): string {
  // A field the hub did not send is unknown, not zero. Rendering it as '0'
  // states a fact nobody measured, which is how a version skew between the
  // page bundle and the hub API turns into a confident wrong number.
  if (!Number.isFinite(value)) return '\u2014';
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`;
  if (value >= 1_000) return `${(value / 1_000).toFixed(1)}k`;
  return String(Math.round(value));
}

/**
 * Evenly spaced x positions for a series, in the 0..1 range.
 *
 * A single point sits at the left edge rather than dividing by zero, which is
 * what a one-bucket timeline is: the sink answered, there is just one day.
 */
export function evenPositions(count: number): number[] {
  if (count <= 0) return [];
  if (count === 1) return [0];
  return Array.from({ length: count }, (_, index) => index / (count - 1));
}
