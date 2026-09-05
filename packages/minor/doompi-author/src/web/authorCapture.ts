import type { ComposerCapture, WebPluginContextItem } from '@agimon-ai/doompi-web-contracts';
import type { AuthorWorkspaceDocument } from './authorWorkspaceStore.ts';
import type { AuthorCrop, AuthorNativeAnchor, AuthorRegionDraft } from './authorViewportTypes.ts';

export const AUTHOR_CAPTURE_MAX_DIMENSION = 1600;
export const AUTHOR_CAPTURE_MAX_BYTES = 2 * 1024 * 1024;
export const AUTHOR_PACKET_MAX_BYTES = 64 * 1024;
export const AUTHOR_COMMENT_MAX_BYTES = 2 * 1024;
export const AUTHOR_QUOTE_MAX_BYTES = 4 * 1024;

export interface AuthorCapturePacketRegion {
  id: string;
  ordinal: number;
  comment: string;
  quote?: string;
  anchor: AuthorNativeAnchor;
  viewport: AuthorRegionDraft['viewport'];
  voiceGrid?: AuthorRegionDraft['voiceGrid'];
}

export interface AuthorCapturePacket {
  version: 1;
  captureId: string;
  capturedAt: number;
  document: { path: string; kind: AuthorWorkspaceDocument['kind']; revision: number; sourceSha256?: string };
  regions: AuthorCapturePacketRegion[];
}

export interface AuthorCaptureProvider {
  capture(signal?: AbortSignal): Promise<{ data: string; mimeType: 'image/png' | 'image/jpeg' }>;
}

const bytes = (value: string): number => new TextEncoder().encode(value).byteLength;

function utf8Prefix(value: string, limit: number): string {
  if (bytes(value) <= limit) return value;
  let low = 0;
  let high = value.length;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (bytes(value.slice(0, middle)) <= limit) low = middle;
    else high = middle - 1;
  }
  return value.slice(0, low);
}

export function createAuthorCapturePacket(
  captureId: string,
  capturedAt: number,
  document: AuthorWorkspaceDocument,
  regions: readonly AuthorRegionDraft[],
): AuthorCapturePacket {
  if (regions.length === 0 || regions.length > 16) throw new Error('Capture requires between 1 and 16 regions.');
  const packet: AuthorCapturePacket = {
    version: 1,
    captureId,
    capturedAt,
    document: {
      path: document.path,
      kind: document.kind,
      revision: document.version,
      ...(document.sourceSha256 === undefined ? {} : { sourceSha256: document.sourceSha256 }),
    },
    regions: regions.map((region, index) => {
      if (
        region.documentPath !== document.path ||
        region.revision !== document.version ||
        region.sourceSha256 !== document.sourceSha256
      ) {
        throw new Error(`Region ${String(index + 1)} is stale for the focused document.`);
      }
      if (region.comment.trim() === '') throw new Error(`Region ${String(index + 1)} requires a comment.`);
      if (bytes(region.comment) > AUTHOR_COMMENT_MAX_BYTES) {
        throw new Error(`Region ${String(index + 1)} comment exceeds 2 KiB.`);
      }
      return {
        id: region.id,
        ordinal: index + 1,
        comment: region.comment,
        ...(region.quote === undefined ? {} : { quote: utf8Prefix(region.quote, AUTHOR_QUOTE_MAX_BYTES) }),
        anchor: structuredClone(region.anchor),
        viewport: { ...region.viewport },
        ...(region.voiceGrid === undefined ? {} : { voiceGrid: { ...region.voiceGrid } }),
      };
    }),
  };
  if (bytes(JSON.stringify(packet)) > AUTHOR_PACKET_MAX_BYTES) throw new Error('Author capture packet exceeds 64 KiB.');
  return packet;
}

export function authorCaptureContext(packet: AuthorCapturePacket): WebPluginContextItem {
  const content = JSON.stringify(packet);
  if (bytes(content) > AUTHOR_PACKET_MAX_BYTES) throw new Error('Author capture packet exceeds 64 KiB.');
  return {
    kind: 'author-capture',
    source: 'author',
    id: packet.captureId,
    label: `${packet.regions.length} region${packet.regions.length === 1 ? '' : 's'} · ${packet.document.path}`,
    content,
  };
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

async function boundedCanvasCapture(
  canvas: HTMLCanvasElement,
): Promise<{ data: string; mimeType: 'image/png' | 'image/jpeg' }> {
  let mimeType: 'image/png' | 'image/jpeg' = 'image/png';
  let blob = await canvasBlob(canvas, mimeType);
  for (const quality of [0.9, 0.75, 0.6, 0.45, 0.3]) {
    if (blob.size <= AUTHOR_CAPTURE_MAX_BYTES) break;
    mimeType = 'image/jpeg';
    blob = await canvasBlob(canvas, mimeType, quality);
  }
  if (blob.size > AUTHOR_CAPTURE_MAX_BYTES) throw new Error('Viewport capture exceeds 2 MiB');
  return { data: await base64(blob), mimeType };
}

export function imageCaptureProvider(image: HTMLImageElement, crop?: AuthorCrop): AuthorCaptureProvider {
  return {
    async capture(signal) {
      throwIfAborted(signal);
      const normalized = crop ?? { x: 0, y: 0, width: 1, height: 1 };
      const source = {
        x: normalized.x * image.naturalWidth,
        y: normalized.y * image.naturalHeight,
        width: normalized.width * image.naturalWidth,
        height: normalized.height * image.naturalHeight,
      };
      if (source.width <= 0 || source.height <= 0) throw new Error('Image is not ready to capture');
      const scale = Math.min(1, AUTHOR_CAPTURE_MAX_DIMENSION / Math.max(source.width, source.height));
      const canvas = document.createElement('canvas');
      canvas.width = Math.max(1, Math.round(source.width * scale));
      canvas.height = Math.max(1, Math.round(source.height * scale));
      const context = canvas.getContext('2d');
      if (context === null) throw new Error('Canvas is unavailable');
      context.drawImage(image, source.x, source.y, source.width, source.height, 0, 0, canvas.width, canvas.height);
      const capture = await boundedCanvasCapture(canvas);
      throwIfAborted(signal);
      return capture;
    },
  };
}

function loadImage(url: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error('Unable to load a region capture.'));
    image.src = url;
  });
}

function drawWrapped(
  context: CanvasRenderingContext2D,
  text: string,
  x: number,
  y: number,
  width: number,
  lineHeight: number,
  maxLines: number,
): void {
  const words = text.split(/\s+/u);
  let line = '';
  let lineIndex = 0;
  for (const word of words) {
    const next = line === '' ? word : `${line} ${word}`;
    if (context.measureText(next).width <= width) {
      line = next;
      continue;
    }
    context.fillText(line, x, y + lineIndex * lineHeight);
    lineIndex += 1;
    if (lineIndex >= maxLines) return;
    line = word;
  }
  if (lineIndex < maxLines && line !== '') context.fillText(line, x, y + lineIndex * lineHeight);
}

export function multiRegionCaptureProvider(regions: readonly AuthorRegionDraft[]): AuthorCaptureProvider {
  return {
    async capture(signal) {
      throwIfAborted(signal);
      const width = 960;
      const tileHeight = 420;
      const naturalHeight = tileHeight * regions.length;
      const scale = Math.min(1, AUTHOR_CAPTURE_MAX_DIMENSION / Math.max(width, naturalHeight));
      const canvas = document.createElement('canvas');
      canvas.width = Math.max(1, Math.round(width * scale));
      canvas.height = Math.max(1, Math.round(naturalHeight * scale));
      const context = canvas.getContext('2d');
      if (context === null) throw new Error('Canvas is unavailable');
      context.scale(scale, scale);
      context.fillStyle = '#101216';
      context.fillRect(0, 0, width, naturalHeight);
      for (const [index, region] of regions.entries()) {
        throwIfAborted(signal);
        const y = index * tileHeight;
        context.fillStyle = '#23272e';
        context.fillRect(12, y + 12, width - 24, tileHeight - 24);
        const mediaWidth = 600;
        const mediaHeight = tileHeight - 48;
        if (region.thumbnailUrl !== undefined) {
          const image = await loadImage(region.thumbnailUrl);
          const imageScale = Math.min(mediaWidth / image.naturalWidth, mediaHeight / image.naturalHeight);
          const drawWidth = image.naturalWidth * imageScale;
          const drawHeight = image.naturalHeight * imageScale;
          const drawX = 24 + (mediaWidth - drawWidth) / 2;
          const drawY = y + 24 + (mediaHeight - drawHeight) / 2;
          context.drawImage(image, drawX, drawY, drawWidth, drawHeight);
          if ('rect' in region.anchor) {
            const rect = region.anchor.rect;
            const rx = drawX + rect.x * drawWidth;
            const ry = drawY + rect.y * drawHeight;
            const rw = rect.width * drawWidth;
            const rh = rect.height * drawHeight;
            context.fillStyle = 'rgba(8,10,13,0.62)';
            context.fillRect(drawX, drawY, drawWidth, Math.max(0, ry - drawY));
            context.fillRect(drawX, ry + rh, drawWidth, Math.max(0, drawY + drawHeight - ry - rh));
            context.fillRect(drawX, ry, Math.max(0, rx - drawX), rh);
            context.fillRect(rx + rw, ry, Math.max(0, drawX + drawWidth - rx - rw), rh);
            context.strokeStyle = '#ff6c6b';
            context.lineWidth = 3;
            context.strokeRect(rx, ry, rw, rh);
          }
        } else {
          context.fillStyle = '#9ca0a4';
          context.font = '16px monospace';
          drawWrapped(context, region.quote ?? 'Selected document region', 36, y + 54, mediaWidth - 36, 24, 11);
        }
        context.fillStyle = '#ff6c6b';
        context.font = 'bold 24px monospace';
        context.fillText(`(${String(index + 1)})`, 650, y + 58);
        context.fillStyle = '#f2f3f5';
        context.font = '15px monospace';
        drawWrapped(context, region.comment, 650, y + 94, 280, 23, 11);
      }
      throwIfAborted(signal);
      return boundedCanvasCapture(canvas);
    },
  };
}

export async function attachAuthorCapture(
  provider: AuthorCaptureProvider,
  context: WebPluginContextItem,
  attach: (capture: ComposerCapture) => void,
  signal?: AbortSignal,
): Promise<void> {
  const capture = await provider.capture(signal);
  throwIfAborted(signal);
  attach({ ...capture, context });
}
