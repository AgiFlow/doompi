import type { ComposerCapture, WebPluginContextItem } from '@agimon-ai/doompi-web-contracts';
import type { AuthorCrop } from './authorViewportTypes.ts';

export const AUTHOR_CAPTURE_MAX_DIMENSION = 1600;
export const AUTHOR_CAPTURE_MAX_BYTES = 2 * 1024 * 1024;
export const AUTHOR_CAPTURE_CONTEXT_MAX_BYTES = 8 * 1024;

export interface AuthorCaptureProvider {
  capture(signal?: AbortSignal): Promise<{ data: string; mimeType: 'image/png' | 'image/jpeg' }>;
}

function canvasBlob(canvas: HTMLCanvasElement, type: 'image/png' | 'image/jpeg', quality?: number): Promise<Blob> {
  return new Promise((resolve, reject) => {
    canvas.toBlob(
      (blob) => (blob === null ? reject(new Error('Unable to capture viewport')) : resolve(blob)),
      type,
      quality,
    );
  });
}

async function base64(blob: Blob): Promise<string> {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  let binary = '';
  for (let offset = 0; offset < bytes.length; offset += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
  }
  return btoa(binary);
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted === true) throw signal.reason;
}

export function imageCaptureProvider(image: HTMLImageElement, crop?: AuthorCrop): AuthorCaptureProvider {
  return {
    async capture(signal) {
      throwIfAborted(signal);
      const source = crop ?? { x: 0, y: 0, width: image.naturalWidth, height: image.naturalHeight };
      if (source.width <= 0 || source.height <= 0) throw new Error('Image is not ready to capture');
      const scale = Math.min(1, AUTHOR_CAPTURE_MAX_DIMENSION / Math.max(source.width, source.height));
      const canvas = document.createElement('canvas');
      canvas.width = Math.max(1, Math.round(source.width * scale));
      canvas.height = Math.max(1, Math.round(source.height * scale));
      const context = canvas.getContext('2d');
      if (context === null) throw new Error('Canvas is unavailable');
      context.drawImage(image, source.x, source.y, source.width, source.height, 0, 0, canvas.width, canvas.height);
      let mimeType: 'image/png' | 'image/jpeg' = 'image/png';
      let blob = await canvasBlob(canvas, mimeType);
      for (const quality of [0.9, 0.75, 0.6, 0.45, 0.3]) {
        if (blob.size <= AUTHOR_CAPTURE_MAX_BYTES) break;
        mimeType = 'image/jpeg';
        blob = await canvasBlob(canvas, mimeType, quality);
      }
      if (blob.size > AUTHOR_CAPTURE_MAX_BYTES) throw new Error('Viewport capture exceeds 2 MiB');
      throwIfAborted(signal);
      return { data: await base64(blob), mimeType };
    },
  };
}

export function boundedCaptureContext(item: WebPluginContextItem): WebPluginContextItem {
  const encoder = new TextEncoder();
  if (encoder.encode(item.content).byteLength <= AUTHOR_CAPTURE_CONTEXT_MAX_BYTES) return item;
  let content = item.content;
  while (content !== '' && encoder.encode(content).byteLength > AUTHOR_CAPTURE_CONTEXT_MAX_BYTES) {
    content = content.slice(0, Math.max(0, content.length - 256));
  }
  return { ...item, content };
}

export async function attachAuthorCapture(
  provider: AuthorCaptureProvider,
  context: WebPluginContextItem,
  attach: (capture: ComposerCapture) => void,
  signal?: AbortSignal,
): Promise<void> {
  const capture = await provider.capture(signal);
  throwIfAborted(signal);
  attach({ ...capture, context: boundedCaptureContext(context) });
}
