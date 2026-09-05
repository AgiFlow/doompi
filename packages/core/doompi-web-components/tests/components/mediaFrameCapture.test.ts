import { afterEach, describe, expect, it, vi } from 'vitest';
import { mediaPreviewController } from '../../src/components/MediaPreview.tsx';

function fixture(options: { context?: boolean; blob?: Blob | null } = {}) {
  const blob = options.blob === undefined ? new Blob(['frame'], { type: 'image/png' }) : options.blob;
  const drawImage = vi.fn();
  const toBlob = vi.fn((callback: BlobCallback) => callback(blob));
  const canvas = {
    width: 0,
    height: 0,
    getContext: vi.fn(() => (options.context === false ? null : { drawImage })),
    toBlob,
  };
  vi.stubGlobal('document', { createElement: vi.fn(() => canvas) });
  const video = { videoWidth: 1920, videoHeight: 1080, currentTime: 2.5 } as HTMLVideoElement;
  return { blob, canvas, drawImage, toBlob, video };
}

afterEach(() => vi.unstubAllGlobals());

describe('video frame capture', () => {
  it('captures intrinsic pixels and copies the decoded frame metadata', async () => {
    const { video, canvas, blob, drawImage, toBlob } = fixture();
    const metadata = { mediaTime: 2.4, presentedFrames: 72 };
    const controller = mediaPreviewController({ current: video }, { current: metadata });
    const result = await controller.captureFrame('image/jpeg', 0.8);
    expect(canvas.width).toBe(1920);
    expect(canvas.height).toBe(1080);
    expect(drawImage).toHaveBeenCalledWith(video, 0, 0, 1920, 1080);
    expect(toBlob).toHaveBeenCalledWith(expect.any(Function), 'image/jpeg', 0.8);
    expect(result).toEqual({ blob, width: 1920, height: 1080, timeSeconds: 2.5, metadata });
    metadata.mediaTime = 3;
    expect(result?.metadata?.mediaTime).toBe(2.4);
  });

  it('captures PNG without inventing frame metadata when callbacks are unavailable', async () => {
    const { video, blob, toBlob } = fixture();
    expect(await mediaPreviewController({ current: video }).captureFrame()).toEqual({
      blob,
      width: 1920,
      height: 1080,
      timeSeconds: 2.5,
    });
    expect(toBlob).toHaveBeenCalledWith(expect.any(Function), 'image/png', undefined);
  });

  it('does not allocate a canvas before metadata or after unmount', async () => {
    fixture();
    for (const current of [null, { videoWidth: 0, videoHeight: 1080 }, { videoWidth: 1920, videoHeight: 0 }]) {
      const controller = mediaPreviewController({ current: current as HTMLVideoElement | null });
      expect(controller.getIntrinsicSize()).toBeNull();
      expect(await controller.captureFrame()).toBeNull();
    }
    expect(document.createElement).not.toHaveBeenCalled();
  });

  it('returns null when a drawing context cannot be allocated', async () => {
    const { video, toBlob } = fixture({ context: false });
    expect(await mediaPreviewController({ current: video }).captureFrame()).toBeNull();
    expect(toBlob).not.toHaveBeenCalled();
  });

  it('returns null when the browser cannot encode a frame', async () => {
    const { video } = fixture({ blob: null });
    expect(await mediaPreviewController({ current: video }).captureFrame()).toBeNull();
  });
});
