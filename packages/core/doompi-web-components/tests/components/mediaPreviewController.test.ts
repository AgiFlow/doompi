import { describe, expect, it, vi } from 'vitest';
import { mediaPlaybackState, mediaPreviewController } from '../../src/components/MediaPreview.tsx';

function video(overrides: Partial<HTMLVideoElement> = {}): HTMLVideoElement {
  return {
    currentTime: 3,
    duration: 10,
    paused: false,
    ended: false,
    pause: vi.fn(),
    play: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  } as HTMLVideoElement;
}

describe('MediaPreview video controller', () => {
  it('plays, pauses, and bounds seeks on the mounted video', async () => {
    const mounted = video();
    const controller = mediaPreviewController({ current: mounted });

    await controller.play();
    controller.pause();
    controller.seek(30);

    expect(mounted.play).toHaveBeenCalledOnce();
    expect(mounted.pause).toHaveBeenCalledOnce();
    expect(mounted.currentTime).toBe(10);
  });

  it('reads playback state from the video rather than duplicating it in React', () => {
    const mounted = video({ currentTime: 7, duration: Number.NaN, paused: true });
    expect(mediaPlaybackState(mounted)).toEqual({ playing: false, currentTime: 7, duration: 0 });
    expect(mediaPreviewController({ current: mounted }).getState()).toEqual({
      playing: false,
      currentTime: 7,
      duration: 0,
    });
  });

  it('is safe during mount and unmount boundaries', async () => {
    const controller = mediaPreviewController({ current: null });
    await controller.play();
    controller.pause();
    controller.seek(2);
    expect(controller.getState()).toEqual({ playing: false, currentTime: 0, duration: 0 });
  });
});
