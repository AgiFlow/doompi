/** Keep an imperative seek inside the playable part of the current video. */
export function boundedMediaTime(seconds: number, duration: number): number {
  if (!Number.isFinite(seconds)) throw new RangeError('Media seek time must be finite');
  const end = Number.isFinite(duration) && duration >= 0 ? duration : Number.POSITIVE_INFINITY;
  return Math.min(Math.max(seconds, 0), end);
}
