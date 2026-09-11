import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const decodeFromConstraints = vi.hoisted(() => vi.fn());

vi.mock('@zxing/browser', () => ({
  BrowserQRCodeReader: class {
    decodeFromConstraints = decodeFromConstraints;
  },
}));

import { startQrScanner } from '../../src/pwa/qrScanner.ts';

class FakeMediaStream {
  getTracks(): never[] {
    return [];
  }
}

function videoElement(): HTMLVideoElement {
  return {
    muted: false,
    playsInline: false,
    srcObject: null,
  } as unknown as HTMLVideoElement;
}

describe('the QR scanner', () => {
  beforeEach(() => {
    decodeFromConstraints.mockReset();
    vi.stubGlobal('MediaStream', FakeMediaStream);
  });

  afterEach(() => vi.unstubAllGlobals());

  it.each(['NotFoundException', 'ChecksumException', 'FormatException'])(
    'keeps scanning after a recoverable %s frame',
    async (name) => {
      const controls = { stop: vi.fn() };
      decodeFromConstraints.mockImplementation(async (_constraints, _video, callback) => {
        const recoverable = Object.assign(new Error('partial frame'), {
          getKind: () => name,
          name: 'minified-production-name',
        });
        callback(undefined, recoverable, controls);
        callback({ getText: () => 'https://doompi.example/pair#code' }, undefined, controls);
        return controls;
      });
      const onResult = vi.fn();
      const onError = vi.fn();

      await startQrScanner(videoElement(), onResult, onError);

      expect(decodeFromConstraints.mock.calls[0]?.[0]).toEqual({
        audio: false,
        video: {
          facingMode: { ideal: 'environment' },
          width: { ideal: 1920 },
          height: { ideal: 1080 },
        },
      });
      expect(onError).not.toHaveBeenCalled();
      expect(onResult).toHaveBeenCalledWith('https://doompi.example/pair#code');
      expect(controls.stop).toHaveBeenCalledOnce();
    },
  );

  it('stops on a fatal decoder error', async () => {
    const controls = { stop: vi.fn() };
    const fatal = Object.assign(new Error('camera failed'), { getKind: () => 'IllegalArgumentException' });
    decodeFromConstraints.mockImplementation(async (_constraints, _video, callback) => {
      callback(undefined, fatal, controls);
      return controls;
    });
    const onResult = vi.fn();
    const onError = vi.fn();

    await startQrScanner(videoElement(), onResult, onError);

    expect(onResult).not.toHaveBeenCalled();
    expect(onError).toHaveBeenCalledWith(fatal);
    expect(controls.stop).toHaveBeenCalledOnce();
  });
});
