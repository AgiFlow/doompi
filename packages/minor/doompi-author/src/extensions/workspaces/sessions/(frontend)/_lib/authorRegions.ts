import type { AuthorNormalizedPoint, AuthorNormalizedRect } from './authorViewportTypes';

export const AUTHOR_STROKE_POINT_LIMIT = 128;

/** Keep freehand evidence small and source-relative. Reject malformed geometry rather than degrading it into a crop. */
export function validAuthorStroke(value: unknown): value is readonly AuthorNormalizedPoint[] {
  return (
    Array.isArray(value) &&
    value.length >= 2 &&
    value.length <= AUTHOR_STROKE_POINT_LIMIT &&
    value.some((point: AuthorNormalizedPoint) => point.x !== value[0]?.x || point.y !== value[0]?.y) &&
    value.every(
      (point: unknown) =>
        typeof point === 'object' &&
        point !== null &&
        Number.isFinite((point as AuthorNormalizedPoint).x) &&
        Number.isFinite((point as AuthorNormalizedPoint).y) &&
        (point as AuthorNormalizedPoint).x >= 0 &&
        (point as AuthorNormalizedPoint).x <= 1 &&
        (point as AuthorNormalizedPoint).y >= 0 &&
        (point as AuthorNormalizedPoint).y <= 1,
    )
  );
}

export function authorStrokeBounds(points: readonly AuthorNormalizedPoint[]): AuthorNormalizedRect | null {
  if (!validAuthorStroke(points)) return null;
  const left = Math.min(...points.map((point) => point.x));
  const top = Math.min(...points.map((point) => point.y));
  const right = Math.max(...points.map((point) => point.x));
  const bottom = Math.max(...points.map((point) => point.y));
  const x = Math.max(0, Math.min(left, 1 - 0.001));
  const y = Math.max(0, Math.min(top, 1 - 0.001));
  return {
    x,
    y,
    width: Math.min(1 - x, Math.max(right - x, 0.001)),
    height: Math.min(1 - y, Math.max(bottom - y, 0.001)),
  };
}

export function appendAuthorStrokePoint(
  points: readonly AuthorNormalizedPoint[],
  point: AuthorNormalizedPoint,
): readonly AuthorNormalizedPoint[] {
  if (!Number.isFinite(point.x) || !Number.isFinite(point.y)) return points;
  const next = { x: Math.max(0, Math.min(1, point.x)), y: Math.max(0, Math.min(1, point.y)) };
  if (points.length >= AUTHOR_STROKE_POINT_LIMIT) return points;
  const last = points.at(-1);
  return last?.x === next.x && last.y === next.y ? points : [...points, next];
}

export interface AuthorClientRect {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

/** Clamp a drag to the source element, including drags made in reverse. */
export function normalizedAuthorRectangle(
  bounds: AuthorClientRect,
  drag: AuthorClientRect,
): AuthorNormalizedRect | null {
  const width = bounds.right - bounds.left;
  const height = bounds.bottom - bounds.top;
  if (![...Object.values(bounds), ...Object.values(drag)].every(Number.isFinite) || width <= 0 || height <= 0)
    return null;
  const left = Math.max(bounds.left, Math.min(drag.left, drag.right));
  const right = Math.min(bounds.right, Math.max(drag.left, drag.right));
  const top = Math.max(bounds.top, Math.min(drag.top, drag.bottom));
  const bottom = Math.min(bounds.bottom, Math.max(drag.top, drag.bottom));
  if (right <= left || bottom <= top) return null;
  return {
    x: (left - bounds.left) / width,
    y: (top - bounds.top) / height,
    width: (right - left) / width,
    height: (bottom - top) / height,
  };
}
