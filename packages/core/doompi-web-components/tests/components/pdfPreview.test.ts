import { describe, expect, it } from 'vitest';
import { resolvePdfViewportRegion } from '../../src/components/PdfPreview.tsx';

describe('PDF page geometry', () => {
  it('clamps a client rectangle and normalizes it within the current source page', () => {
    expect(
      resolvePdfViewportRegion(
        3,
        { left: 100, top: 50, right: 500, bottom: 250, width: 400, height: 200 },
        { left: 0, top: 100, right: 300, bottom: 300 },
      ),
    ).toEqual({ page: 3, rect: { x: 0, y: 0.25, width: 0.5, height: 0.75 } });
  });

  it('rejects rectangles that do not intersect a page', () => {
    expect(
      resolvePdfViewportRegion(
        1,
        { left: 100, top: 50, right: 500, bottom: 250, width: 400, height: 200 },
        { left: 0, top: 0, right: 50, bottom: 25 },
      ),
    ).toBeNull();
  });
});
