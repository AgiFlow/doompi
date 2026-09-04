import type { AuthorNormalizedRect } from './authorViewportTypes.ts';

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
