/**
 * The image half of the read override.
 *
 * DESIGN PATTERNS:
 * - Pi's read tool already decodes, converts and resizes images, but its only
 *   knob is on/off: the 2000px cap is a constant inside its resize core. So the
 *   native tool is asked not to resize, and the block it returns is resized
 *   here against the machine's configured cap, with Pi's own exported resize so
 *   the two surfaces cannot drift apart in filter, format ladder or byte limit.
 * - The limits are read per image read rather than captured at registration,
 *   because the cockpit settings page writes them while a session is running.
 *
 * CODING STANDARDS:
 * - Keep Pi's wording for the omission and the coordinate note. A model that
 *   learned Pi's phrasing should not have to learn a second one.
 *
 * AVOID:
 * - Dropping an image silently. An image that cannot be brought under the limit
 *   is reported in the text, exactly as Pi's own read reports it.
 */

import { loadPiImageSettings, type PiImageSettings } from '@agimon-ai/doompi-config/config/piConfig';
import { formatDimensionNote, resizeImage } from '@earendil-works/pi-coding-agent';

/** Pi's own message for an image no resize pass could bring under the limit. */
const OMITTED_NOTE = '[Image omitted: could not be resized below the inline image size limit.]';

/** Structurally Pi's own TextContent and ImageContent, without the pi-ai dependency. */
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

function isImagePart(part: ReadContentPart): part is ReadImagePart {
  return part.type === 'image';
}

export function imageLimits(): PiImageSettings {
  return loadPiImageSettings();
}

/**
 * Applies the configured cap to every image block, leaving text untouched.
 *
 * Returns the same array when nothing changed, so a caller can hand the native
 * result straight back.
 */
export async function applyImageLimits(
  content: ReadContentPart[],
  limits: PiImageSettings,
): Promise<ReadContentPart[]> {
  if (!limits.autoResize || !content.some(isImagePart)) return content;
  const resolved: ReadContentPart[] = [];
  for (const part of content) {
    if (!isImagePart(part)) {
      resolved.push(part);
      continue;
    }
    const resized = await resizeImage(Buffer.from(part.data, 'base64'), part.mimeType, {
      maxWidth: limits.maxDimension,
      maxHeight: limits.maxDimension,
    });
    if (!resized) {
      resolved.push({ type: 'text', text: OMITTED_NOTE });
      continue;
    }
    resolved.push({ type: 'image', data: resized.data, mimeType: resized.mimeType });
    const note = formatDimensionNote(resized);
    if (note) resolved.push({ type: 'text', text: note });
  }
  return resolved;
}
