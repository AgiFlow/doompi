/**
 * Brings browser-attached images under the machine's limit before they reach a
 * session.
 *
 * Pi resizes images it reads and images any tool returns, but not the ones a
 * user attaches: its RPC prompt, steer and follow_up paths hand the blocks
 * straight to the model. A cockpit paste is therefore the one image on a
 * machine nothing has looked at, and an oversized one is rejected by the
 * provider for the whole conversation rather than for that turn.
 *
 * The resize is Pi's own, so a pasted screenshot and a read screenshot come out
 * of the same pass with the same filter, format ladder and byte ceiling.
 *
 * AVOID:
 * - Dropping a frame when the resize fails. The original is forwarded instead:
 *   a provider that still accepts it is a better outcome than a lost message.
 */

import { loadPiImageSettings, type PiImageSettings } from '@agimon-ai/doompi-config/config/piConfig';
import { formatDimensionNote, resizeImage } from '@earendil-works/pi-coding-agent';
import type { SessionFrame } from '../types/session.ts';

/** The three ways a page sends the user's own images into a session. */
const IMAGE_BEARING_COMMANDS = new Set(['prompt', 'steer', 'follow_up']);

interface FrameImage {
  type: 'image';
  data: string;
  mimeType: string;
}

function isFrameImage(value: unknown): value is FrameImage {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as Record<string, unknown>;
  return candidate.type === 'image' && typeof candidate.data === 'string' && typeof candidate.mimeType === 'string';
}

/** Whether this frame is worth the asynchronous detour. */
export function carriesUserImages(frame: SessionFrame): boolean {
  if (typeof frame.type !== 'string' || !IMAGE_BEARING_COMMANDS.has(frame.type)) return false;
  return Array.isArray(frame.images) && frame.images.some(isFrameImage);
}

export function userImageLimits(): PiImageSettings {
  return loadPiImageSettings();
}

/**
 * Returns the frame to forward: the same object when nothing needed changing,
 * otherwise a copy whose images fit the cap and whose message carries Pi's
 * coordinate note for each one that moved.
 */
export async function shrinkUserImages(frame: SessionFrame, limits: PiImageSettings): Promise<SessionFrame> {
  if (!limits.autoResize || !carriesUserImages(frame)) return frame;
  const images: unknown[] = [];
  const notes: string[] = [];
  let changed = false;
  for (const image of frame.images as unknown[]) {
    if (!isFrameImage(image)) {
      images.push(image);
      continue;
    }
    const resized = await resizeImage(Buffer.from(image.data, 'base64'), image.mimeType, {
      maxWidth: limits.maxDimension,
      maxHeight: limits.maxDimension,
    });
    if (!resized) {
      images.push(image);
      continue;
    }
    images.push({ type: 'image', data: resized.data, mimeType: resized.mimeType });
    const note = formatDimensionNote(resized);
    if (note) notes.push(note);
    changed ||= resized.data !== image.data || resized.mimeType !== image.mimeType;
  }
  if (!changed) return frame;
  const message =
    typeof frame.message === 'string' && notes.length > 0 ? `${frame.message}\n${notes.join('\n')}` : frame.message;
  return { ...frame, images, ...(message === undefined ? {} : { message }) };
}
