import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  attachAuthorCapture,
  imageCaptureProvider,
  multiRegionCaptureProvider,
  AUTHOR_CAPTURE_MAX_BYTES,
} from '../../src/web/authorCapture.ts';
import type { AuthorRegionDraft } from '../../src/web/authorViewportTypes.ts';

function canvasFixture(blobs: (Blob | null)[] = [new Blob(['png'])]) {
  const context = {
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
  it('renders numbered text regions, wraps long content, and bounds the contact sheet', async () => {
    const { canvas, context } = canvasFixture();
    const regions = [
      region,
      { ...region, quote: 'word '.repeat(400), comment: 'comment '.repeat(200) },
      { ...region, quote: '' },
      ...Array.from({ length: 2 }, () => region),
    ];
    await multiRegionCaptureProvider(regions).capture();
    expect(canvas.height).toBe(1600);
    expect(context.fillText).toHaveBeenCalledWith('(1)', 650, 58);
    expect(context.fillText).toHaveBeenCalledWith('Selected document region', 36, 54);
    expect(context.fillText).toHaveBeenCalledWith('(5)', 650, 1738);
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
    expect(context.strokeRect).toHaveBeenCalledWith(174, 135, 300, 150);
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
