import { describe, expect, it } from 'vitest';
import { boundedMediaTime } from '../../src/lib/mediaPlayback.ts';

describe('boundedMediaTime', () => {
  it('keeps seeks inside a video with known duration', () => {
    expect(boundedMediaTime(-2, 12)).toBe(0);
    expect(boundedMediaTime(4, 12)).toBe(4);
    expect(boundedMediaTime(20, 12)).toBe(12);
  });

  it('allows forward seeks while metadata is not loaded', () => {
    expect(boundedMediaTime(20, Number.NaN)).toBe(20);
  });

  it('rejects non-finite seek requests', () => {
    expect(() => boundedMediaTime(Number.NaN, 12)).toThrow(RangeError);
  });
});
