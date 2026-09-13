import type { ComposerCapture, WebPluginContextItem } from '@agimon-ai/doompi-core/web';

import type { AuthorCrop, AuthorNativeAnchor, AuthorRegionDraft } from '../lib/authorViewportTypes';
import type { AuthorWorkspaceDocument } from './authorWorkspaceStore';

export const AUTHOR_CAPTURE_MAX_DIMENSION = 1600;
export const AUTHOR_CAPTURE_MAX_BYTES = 2 * 1024 * 1024;
export const AUTHOR_PACKET_MAX_BYTES = 64 * 1024;
export const AUTHOR_COMMENT_MAX_BYTES = 2 * 1024;
export const AUTHOR_QUOTE_MAX_BYTES = 4 * 1024;
export const AUTHOR_REGION_COLORS = [
  '#ff5f57',
  '#00c2ff',
  '#ffd166',
  '#b388ff',
  '#4ade80',
  '#ff8c42',
  '#f472b6',
  '#2dd4bf',
  '#a3e635',
  '#60a5fa',
  '#e879f9',
  '#facc15',
  '#34d399',
  '#fb7185',
  '#818cf8',
  '#22d3ee',
] as const;

function annotationForeground(color: string): '#101216' | '#ffffff' {
  const red = Number.parseInt(color.slice(1, 3), 16);
  const green = Number.parseInt(color.slice(3, 5), 16);
  const blue = Number.parseInt(color.slice(5, 7), 16);
  return red * 299 + green * 587 + blue * 114 >= 150_000 ? '#101216' : '#ffffff';
}

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

function rectLocation(rect: AuthorCrop): string {
  const percent = (value: number) => `${String(Math.round(value * 1_000) / 10)}%`;
  return `x ${percent(rect.x)}, y ${percent(rect.y)}, w ${percent(rect.width)}, h ${percent(rect.height)}`;
}

function anchorLocation(anchor: AuthorNativeAnchor): string {
  switch (anchor.kind) {
    case 'text-range':
      return anchor.startLine === anchor.endLine
        ? `line ${String(anchor.startLine)}`
        : `lines ${String(anchor.startLine)}-${String(anchor.endLine)}`;
    case 'cell':
      return `${anchor.sheet === undefined ? '' : `${anchor.sheet}!`}${anchor.location}`;
    case 'slide-element':
      return `slide ${String(anchor.slide)}: ${anchor.location}`;
    case 'image-rect':
      return `image ${rectLocation(anchor.rect)}`;
    case 'pdf-page-rect':
      return `page ${String(anchor.page)}, ${rectLocation(anchor.rect)}`;
    case 'video-time-rect':
      return `time ${anchor.timeSeconds.toFixed(3)}s${anchor.frame === undefined ? '' : `, frame ${String(anchor.frame)}`}, ${rectLocation(anchor.rect)}`;
  }
}
export function authorCaptureContext(packet: AuthorCapturePacket): WebPluginContextItem {
  const metadata = JSON.stringify(packet);
  if (bytes(metadata) > AUTHOR_PACKET_MAX_BYTES) throw new Error('Author capture packet exceeds 64 KiB.');
  const content = packet.regions
    .map(
      (region) =>
        `(${String(region.ordinal)}) ${region.comment} [${anchorLocation(region.anchor)}]${region.quote ? `\nQuoted text: ${region.quote}` : ''}`,
    )
    .join('\n\n');
  return {
    kind: 'author-capture',
    source: 'author',
    id: packet.captureId,
    label: `${packet.regions.length} region${packet.regions.length === 1 ? '' : 's'} · ${packet.document.path}`,
    content,
    metadata,
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

export function multiRegionCaptureProvider(regions: readonly AuthorRegionDraft[]): AuthorCaptureProvider {
  return {
    async capture(signal) {
      throwIfAborted(signal);
      if (regions.length === 0 || regions.length > 16) throw new Error('Capture requires between 1 and 16 regions.');
      const tiles = [];
      for (const region of regions) {
        const image = region.thumbnailUrl === undefined ? undefined : await loadImage(region.thumbnailUrl);
        throwIfAborted(signal);
        const width = image?.naturalWidth ?? region.viewport.width;
        const height = image?.naturalHeight ?? region.viewport.height;
        if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) {
          throw new Error('Image is not ready to capture');
        }
        tiles.push({ region, image, width, height });
      }
      const width = Math.min(AUTHOR_CAPTURE_MAX_DIMENSION, Math.max(...tiles.map((tile) => tile.width)));
      const naturalHeight = tiles.reduce((height, tile) => height + (tile.height * width) / tile.width, 0);
      const scale = Math.min(1, AUTHOR_CAPTURE_MAX_DIMENSION / Math.max(width, naturalHeight));
      const canvas = document.createElement('canvas');
      canvas.width = Math.max(1, Math.round(width * scale));
      canvas.height = Math.max(1, Math.round(naturalHeight * scale));
      const context = canvas.getContext('2d');
      if (context === null) throw new Error('Canvas is unavailable');
      context.scale(scale, scale);
      context.fillStyle = '#101216';
      context.fillRect(0, 0, width, naturalHeight);
      let y = 0;
      for (const [index, { region, image, width: sourceWidth, height: sourceHeight }] of tiles.entries()) {
        const annotationColor = AUTHOR_REGION_COLORS[index % AUTHOR_REGION_COLORS.length]!;
        throwIfAborted(signal);
        const tileHeight = (sourceHeight * width) / sourceWidth;
        const drawWidth = width;
        const drawHeight = tileHeight;
        const drawX = 0;
        const drawY = y;
        let labelX = drawX;
        let labelY = drawY;
        if (image !== undefined) {
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
            context.strokeStyle = annotationColor;
            context.lineWidth = 3;
            context.strokeRect(rx, ry, rw, rh);
            labelX = rx;
            labelY = ry;
          }
        }
        // Keep ordinals readable after downscaling, but never larger than their image.
        const ordinal = String(index + 1);
        let badgeScale = Math.min(1 / scale, drawHeight / 36);
        context.font = `bold ${String(24 * badgeScale)}px monospace`;
        const measuredWidth = context.measureText(ordinal).width + 12 * badgeScale;
        if (measuredWidth > drawWidth) badgeScale *= drawWidth / measuredWidth;
        context.font = `bold ${String(24 * badgeScale)}px monospace`;
        context.textBaseline = 'top';
        const padding = 6 * badgeScale;
        const labelWidth = Math.min(drawWidth, context.measureText(ordinal).width + padding * 2);
        const labelHeight = 36 * badgeScale;
        labelX = Math.max(drawX, Math.min(labelX, drawX + drawWidth - labelWidth));
        labelY = Math.max(drawY, Math.min(labelY, drawY + drawHeight - labelHeight));
        context.fillStyle = annotationColor;
        context.fillRect(labelX, labelY, labelWidth, labelHeight);
        context.fillStyle = annotationForeground(annotationColor);
        context.fillText(ordinal, labelX + padding, labelY + padding);
        y += tileHeight;
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
