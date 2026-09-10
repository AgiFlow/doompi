import { loadPiImageSettings, type PiImageSettings } from '@agimon-ai/doompi-config/config/piConfig';

const OMITTED_NOTE = '[Image omitted: could not be resized below the inline image size limit.]';

export interface ReadTextPart {
  type: 'text';
  text: string;
}

export interface ReadImagePart {
  type: 'image';
  data: string;
  mimeType: string;
}

export type ReadContentPart = ReadTextPart | ReadImagePart;

export interface ReadImageResizeResult {
  readonly data: string;
  readonly mimeType: string;
  readonly originalWidth: number;
  readonly originalHeight: number;
  readonly width: number;
  readonly height: number;
  readonly wasResized: boolean;
}

export interface ReadImageResizeOperations {
  resize(
    inputBytes: Uint8Array,
    mimeType: string,
    options: { readonly maxWidth: number; readonly maxHeight: number },
  ): Promise<ReadImageResizeResult | null>;
  formatDimensionNote(result: ReadImageResizeResult): string | undefined;
}

export function imageLimits(): PiImageSettings {
  return loadPiImageSettings();
}

export async function applyImageLimits(
  content: ReadContentPart[],
  limits: PiImageSettings,
  operations: ReadImageResizeOperations,
): Promise<ReadContentPart[]> {
  if (!limits.autoResize || !content.some((part) => part.type === 'image')) return content;
  const resolved: ReadContentPart[] = [];
  for (const part of content) {
    if (part.type !== 'image') {
      resolved.push(part);
      continue;
    }
    const resized = await operations.resize(Buffer.from(part.data, 'base64'), part.mimeType, {
      maxWidth: limits.maxDimension,
      maxHeight: limits.maxDimension,
    });
    if (!resized) {
      resolved.push({ type: 'text', text: OMITTED_NOTE });
      continue;
    }
    resolved.push({ type: 'image', data: resized.data, mimeType: resized.mimeType });
    const note = operations.formatDimensionNote(resized);
    if (note) resolved.push({ type: 'text', text: note });
  }
  return resolved;
}
