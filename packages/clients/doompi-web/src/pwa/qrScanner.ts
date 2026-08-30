import { BrowserQRCodeReader, type IScannerControls } from '@zxing/browser';

const RECOVERABLE_DECODE_ERRORS = new Set(['NotFoundException', 'ChecksumException', 'FormatException']);
const CAMERA_CONSTRAINTS: MediaStreamConstraints = {
  audio: false,
  video: {
    facingMode: { ideal: 'environment' },
    width: { ideal: 1920 },
    height: { ideal: 1080 },
  },
};

export interface QrScannerSession {
  stop(): void;
}

function stopMedia(video: HTMLVideoElement, controls: IScannerControls | undefined): void {
  controls?.stop();
  const stream = video.srcObject;
  if (stream instanceof MediaStream) {
    for (const track of stream.getTracks()) track.stop();
  }
  video.srcObject = null;
}

/** Starts camera decoding after the caller has received a user gesture. */
export async function startQrScanner(
  video: HTMLVideoElement,
  onResult: (value: string) => void,
  onError: (error: Error) => void,
): Promise<QrScannerSession> {
  video.playsInline = true;
  video.muted = true;

  const reader = new BrowserQRCodeReader();
  let controls: IScannerControls | undefined;
  let stopped = false;
  const stop = (): void => {
    if (stopped) return;
    stopped = true;
    stopMedia(video, controls);
  };

  try {
    controls = await reader.decodeFromConstraints(CAMERA_CONSTRAINTS, video, (result, error, activeControls) => {
      controls ??= activeControls;
      if (stopped) return;
      if (result !== undefined) {
        const value = result.getText();
        stop();
        onResult(value);
        return;
      }
      if (error !== undefined && !RECOVERABLE_DECODE_ERRORS.has(error.getKind())) {
        stop();
        onError(error instanceof Error ? error : new Error(String(error)));
      }
    });
  } catch (error) {
    stop();
    throw error instanceof Error ? error : new Error(String(error));
  }

  return { stop };
}
