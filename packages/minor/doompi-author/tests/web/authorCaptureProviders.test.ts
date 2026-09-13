import { afterEach, describe, expect, it, vi } from 'vitest';

import type { AuthorRegionDraft } from '../../src/web/lib/authorViewportTypes';
import {
  attachAuthorCapture,
  imageCaptureProvider,
  multiRegionCaptureProvider,
  AUTHOR_CAPTURE_MAX_BYTES,
  AUTHOR_REGION_COLORS,
} from '../../src/web/stores/authorCapture';

function canvasFixture(blobs: (Blob | null)[] = [new Blob(['png'])]) {
  const context = {
    fillStyle: '',
    strokeStyle: '',
    font: '',
    textBaseline: '',
    drawImage: vi.fn(),
    scale: vi.fn(),
    fillRect: vi.fn(),
    strokeRect: vi.fn(),
    fillText: vi.fn(),
    measureText: (text: string) => ({ width: text.length * 10 }),
  };
  const canvas = {
    width: 0,
    height: 0,
    getContext: vi.fn(() => context),
    toBlob: vi.fn((callback: (blob: Blob | null) => void) => callback(blobs.length > 1 ? blobs.shift()! : blobs[0]!)),
  };
  vi.stubGlobal('document', { createElement: vi.fn(() => canvas) });
  return { canvas, context };
}
const image = { naturalWidth: 3200, naturalHeight: 1600 } as HTMLImageElement;
const region: AuthorRegionDraft = {
  id: 'r',
  documentPath: 'a.png',
  revision: 0,
  comment: 'Keep this detail',
  anchor: {
    kind: 'image-rect',
    rect: { x: 0.25, y: 0.25, width: 0.5, height: 0.5 },
    naturalWidth: 800,
    naturalHeight: 600,
  },
  viewport: { width: 800, height: 600 },
  createdAt: 1,
};
afterEach(() => vi.unstubAllGlobals());

describe('Author browser capture providers', () => {
  it('scales full images and maps crop coordinates before encoding', async () => {
    const { canvas, context } = canvasFixture();
    expect(await imageCaptureProvider(image).capture()).toEqual({ data: btoa('png'), mimeType: 'image/png' });
    expect([canvas.width, canvas.height]).toEqual([1600, 800]);
    expect(context.drawImage).toHaveBeenLastCalledWith(image, 0, 0, 3200, 1600, 0, 0, 1600, 800);
    await imageCaptureProvider(image, { x: 0.25, y: 0.25, width: 0.25, height: 0.5 }).capture();
    expect(context.drawImage).toHaveBeenLastCalledWith(image, 800, 400, 800, 800, 0, 0, 800, 800);
  });
  it('falls back to bounded JPEG and rejects images that remain too large', async () => {
    const huge = new Blob([new Uint8Array(AUTHOR_CAPTURE_MAX_BYTES + 1)]);
    const { canvas } = canvasFixture([huge, huge, new Blob(['jpeg'])]);
    expect(await imageCaptureProvider(image).capture()).toEqual({ data: btoa('jpeg'), mimeType: 'image/jpeg' });
    expect(canvas.toBlob).toHaveBeenLastCalledWith(expect.any(Function), 'image/jpeg', 0.75);
    canvasFixture([huge]);
    await expect(imageCaptureProvider(image).capture()).rejects.toThrow('exceeds 2 MiB');
  });
  it('rejects unavailable images, canvases and failed encoders', async () => {
    const fixture = canvasFixture([null]);
    await expect(imageCaptureProvider(image).capture()).rejects.toThrow('Unable to capture');
    fixture.canvas.getContext.mockReturnValueOnce(null as never);
    await expect(imageCaptureProvider(image).capture()).rejects.toThrow('Canvas is unavailable');
    for (const dimensions of [
      { naturalWidth: 0, naturalHeight: 1 },
      { naturalWidth: 1, naturalHeight: 0 },
    ]) {
      await expect(imageCaptureProvider(dimensions as HTMLImageElement).capture()).rejects.toThrow('not ready');
    }
  });
  it('honors cancellation before and after encoding without attaching stale captures', async () => {
    const { canvas } = canvasFixture();
    const controller = new AbortController();
    controller.abort(new Error('cancelled'));
    await expect(imageCaptureProvider(image).capture(controller.signal)).rejects.toThrow('cancelled');
    const late = new AbortController();
    canvas.toBlob.mockImplementationOnce((callback) => {
      late.abort(new Error('late'));
      callback(new Blob(['png']));
    });
    await expect(imageCaptureProvider(image).capture(late.signal)).rejects.toThrow('late');
    const attach = vi.fn();
    const context = { kind: 'author-capture', source: 'author', id: 'id', label: 'capture', content: '{}' };
    await expect(
      attachAuthorCapture(
        { capture: async () => ({ data: 'png', mimeType: 'image/png' }) },
        context,
        attach,
        controller.signal,
      ),
    ).rejects.toThrow('cancelled');
    expect(attach).not.toHaveBeenCalled();
  });
  it('renders only ordinals, never comments or quotes, and bounds the contact sheet', async () => {
    const { canvas, context } = canvasFixture();
    const regions = Array.from({ length: 16 }, (_, index) => ({
      ...region,
      id: String(index),
      quote: 'quote '.repeat(400),
      comment: 'comment '.repeat(200),
    }));
    await multiRegionCaptureProvider(regions).capture();
    expect(canvas.height).toBe(1600);
    expect(canvas.width).toBeLessThanOrEqual(1600);
    expect(context.fillText.mock.calls.map(([text]) => text)).toEqual(regions.map((_, index) => String(index + 1)));
    expect(Number.parseFloat(context.font.split(' ')[1]!)).toBeCloseTo(144);
    expect(context.fillStyle).toBe('#101216');
    expect(context.textBaseline).toBe('top');
  });
  it('draws thumbnails with selection outlines only for rectangular anchors', async () => {
    const { context } = canvasFixture();
    vi.stubGlobal(
      'Image',
      class {
        naturalWidth = 600;
        naturalHeight = 300;
        onload?: () => void;
        set src(_url: string) {
          this.onload?.();
        }
      },
    );
    await multiRegionCaptureProvider([
      { ...region, thumbnailUrl: 'blob:image' },
      {
        ...region,
        thumbnailUrl: 'blob:text',
        anchor: { kind: 'text-range', startOffset: 0, endOffset: 1, startLine: 1, endLine: 1 },
      },
    ]).capture();
    expect(context.drawImage).toHaveBeenCalledTimes(2);
    expect(context.strokeRect).toHaveBeenCalledOnce();
    expect(context.drawImage).toHaveBeenNthCalledWith(1, expect.anything(), 0, 0, 600, 300);
    expect(context.strokeRect).toHaveBeenCalledWith(150, 75, 300, 150);
    expect(context.fillText).toHaveBeenNthCalledWith(1, '1', 156, 81);
    expect(context.fillRect).toHaveBeenCalledWith(150, 75, 22, 36);
    expect(context.fillText).toHaveBeenNthCalledWith(2, '2', 6, 306);
  });
  it('clamps high-contrast ordinal badges at all image edges, including two-digit ordinals', async () => {
    const { context } = canvasFixture();
    const badgeColors: string[] = [];
    const outlineColors: string[] = [];
    context.fillRect.mockImplementation(() => {
      badgeColors.push(context.fillStyle);
    });
    context.strokeRect.mockImplementation(() => {
      outlineColors.push(context.strokeStyle);
    });
    vi.stubGlobal(
      'Image',
      class {
        naturalWidth = 912;
        naturalHeight = 372;
        onload?: () => void;
        set src(_url: string) {
          this.onload?.();
        }
      },
    );
    const regions = Array.from({ length: 16 }, (_, index): AuthorRegionDraft => ({
      ...region,
      thumbnailUrl: 'blob:image',
      anchor: {
        kind: 'image-rect',
        naturalWidth: 912,
        naturalHeight: 372,
        rect: { x: index % 2 === 0 ? 0 : 0.999, y: index < 8 ? 0 : 0.999, width: 0.001, height: 0.001 },
      },
    }));
    await multiRegionCaptureProvider(regions).capture();
    const scale = 1600 / (372 * 16);
    for (const [index, [text, x, y]] of context.fillText.mock.calls.entries()) {
      const labelWidth = String(text).length * 10 + 12 / scale;
      const left = Number(x) - 6 / scale;
      const top = Number(y) - 6 / scale;
      expect(left).toBeGreaterThanOrEqual(0);
      expect(left + labelWidth).toBeLessThanOrEqual(912);
      expect(top).toBeGreaterThanOrEqual(index * 372);
      expect(top + 36 / scale).toBeLessThanOrEqual((index + 1) * 372);
      expect(context.fillRect).toHaveBeenCalledWith(left, top, labelWidth, 36 / scale);
    }
    expect(badgeColors.filter((color) => (AUTHOR_REGION_COLORS as readonly string[]).includes(color))).toEqual(
      AUTHOR_REGION_COLORS,
    );
    expect(outlineColors).toEqual(AUTHOR_REGION_COLORS);
    expect(new Set(outlineColors).size).toBe(16);
    expect(context.fillStyle).toBe('#101216');
  });
  it.each([
    [1698, 1080, 1600, 1018],
    [1080, 1698, 1018, 1600],
    [600, 300, 600, 300],
  ])('fits a %ix%i image without letterboxing', async (naturalWidth, naturalHeight, expectedWidth, expectedHeight) => {
    const { canvas, context } = canvasFixture();
    vi.stubGlobal(
      'Image',
      class {
        naturalWidth = naturalWidth;
        naturalHeight = naturalHeight;
        onload?: () => void;
        set src(_url: string) {
          this.onload?.();
        }
      },
    );
    await multiRegionCaptureProvider([{ ...region, thumbnailUrl: 'blob:image' }]).capture();
    expect([canvas.width, canvas.height]).toEqual([expectedWidth, expectedHeight]);
    const [, x, y, width, height] = context.drawImage.mock.calls[0]!;
    expect([x, y]).toEqual([0, 0]);
    expect(Number(width) / Number(height)).toBeCloseTo(naturalWidth / naturalHeight);
    const [scale] = context.scale.mock.calls[0]!;
    expect(Number(width) * Number(scale)).toBeCloseTo(canvas.width, 0);
    expect(Number(height) * Number(scale)).toBeCloseTo(canvas.height, 0);
  });
  it('rejects empty and oversized contact sheets', async () => {
    canvasFixture();
    await expect(multiRegionCaptureProvider([]).capture()).rejects.toThrow('between 1 and 16');
    await expect(multiRegionCaptureProvider(Array.from({ length: 17 }, () => region)).capture()).rejects.toThrow(
      'between 1 and 16',
    );
  });
  it('keeps multi-region encoded output within the byte limit', async () => {
    const huge = new Blob([new Uint8Array(AUTHOR_CAPTURE_MAX_BYTES + 1)]);
    canvasFixture([huge, new Blob(['jpeg'])]);
    await expect(multiRegionCaptureProvider([region]).capture()).resolves.toEqual({
      data: btoa('jpeg'),
      mimeType: 'image/jpeg',
    });
    canvasFixture([huge]);
    await expect(multiRegionCaptureProvider([region]).capture()).rejects.toThrow('exceeds 2 MiB');
  });
  it('rejects thumbnail loading failures and missing contact-sheet canvas', async () => {
    const { canvas } = canvasFixture();
    vi.stubGlobal(
      'Image',
      class {
        onerror?: () => void;
        set src(_url: string) {
          this.onerror?.();
        }
      },
    );
    await expect(multiRegionCaptureProvider([{ ...region, thumbnailUrl: 'broken' }]).capture()).rejects.toThrow(
      'Unable to load',
    );
    canvas.getContext.mockReturnValueOnce(null as never);
    await expect(multiRegionCaptureProvider([region]).capture()).rejects.toThrow('Canvas is unavailable');
  });
});
