import { describe, expect, it } from 'vitest';
import { normalizedAuthorRectangle } from '../../src/web/authorRegions.ts';

describe('source-normalized Author rectangles', () => {
  const bounds = { left: 100, top: 50, right: 500, bottom: 250 };
  it('handles reverse drags and CSS scaling', () => {
    expect(normalizedAuthorRectangle(bounds, { left: 400, top: 200, right: 200, bottom: 100 })).toEqual({
      x: 0.25,
      y: 0.25,
      width: 0.5,
      height: 0.5,
    });
  });
  it('clips to media edges', () => {
    expect(normalizedAuthorRectangle(bounds, { left: 0, top: 0, right: 600, bottom: 300 })).toEqual({
      x: 0,
      y: 0,
      width: 1,
      height: 1,
    });
  });
  it('rejects missing intersections and nonfinite coordinates', () => {
    expect(normalizedAuthorRectangle(bounds, { left: 0, top: 0, right: 10, bottom: 10 })).toBeNull();
    expect(normalizedAuthorRectangle(bounds, { left: NaN, top: 0, right: 200, bottom: 100 })).toBeNull();
  });
});
