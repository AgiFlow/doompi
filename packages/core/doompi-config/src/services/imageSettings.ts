/**
 * The image limits every DoomPi surface applies before an image reaches a model.
 *
 * Pi already owns half of this: `images.autoResize` lives in its settings.json
 * and its resize core hardcodes a 2000px cap. What Pi has no place for is a
 * smaller cap, so `images.maxDimension` is Doom's key written into the same
 * file, because a machine should describe how images reach a model in one
 * place rather than two.
 *
 * A cap above Pi's own is not offered. Pi normalizes every tool result image at
 * 2000px as it enters session history, so a larger number would hold on a
 * pasted image and be silently undone on a read. Clamping says so instead of
 * letting the two surfaces disagree.
 *
 * AVOID:
 * - Reading these keys straight off a config record; a hand-written file holds
 *   strings, nulls and negative numbers, and only this parser answers for them.
 */

import type { PiConfig } from '../schemas/config/schema.ts';

export const IMAGE_SETTINGS_KEY = 'images';
export const IMAGE_AUTO_RESIZE_KEY = 'autoResize';
export const IMAGE_MAX_DIMENSION_KEY = 'maxDimension';

/** Pi's own cap, from its resize core; also the largest value worth writing. */
export const DEFAULT_IMAGE_MAX_DIMENSION = 2000;
/** Below this a screenshot stops being readable, which is what reads are for. */
export const MIN_IMAGE_MAX_DIMENSION = 256;

export interface PiImageSettings {
  /** Pi's own toggle. Unset is on, matching Pi's default. */
  autoResize: boolean;
  /** The longest edge an image keeps once resizing is on. */
  maxDimension: number;
}

/** The written form of a change; an absent field leaves that key alone. */
export interface PiImageSettingsUpdate {
  autoResize?: boolean;
  maxDimension?: number;
}

export function clampImageMaxDimension(value: number): number {
  const rounded = Math.round(value);
  if (rounded < MIN_IMAGE_MAX_DIMENSION) return MIN_IMAGE_MAX_DIMENSION;
  if (rounded > DEFAULT_IMAGE_MAX_DIMENSION) return DEFAULT_IMAGE_MAX_DIMENSION;
  return rounded;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Resolves the effective limits, defaulting anything absent or unusable. */
export function parsePiImageSettings(config: PiConfig): PiImageSettings {
  const images = config[IMAGE_SETTINGS_KEY];
  if (!isRecord(images)) return { autoResize: true, maxDimension: DEFAULT_IMAGE_MAX_DIMENSION };
  const autoResize = images[IMAGE_AUTO_RESIZE_KEY];
  const maxDimension = images[IMAGE_MAX_DIMENSION_KEY];
  return {
    autoResize: typeof autoResize === 'boolean' ? autoResize : true,
    maxDimension:
      typeof maxDimension === 'number' && Number.isFinite(maxDimension)
        ? clampImageMaxDimension(maxDimension)
        : DEFAULT_IMAGE_MAX_DIMENSION,
  };
}

/**
 * Folds a change into the `images` object of a settings document, leaving every
 * other key of that document, and of `images` itself, as it was.
 */
export function applyPiImageSettings(config: PiConfig, update: PiImageSettingsUpdate): PiConfig {
  const existing = config[IMAGE_SETTINGS_KEY];
  const images: Record<string, unknown> = isRecord(existing) ? { ...existing } : {};
  if (update.autoResize !== undefined) images[IMAGE_AUTO_RESIZE_KEY] = update.autoResize;
  if (update.maxDimension !== undefined) images[IMAGE_MAX_DIMENSION_KEY] = clampImageMaxDimension(update.maxDimension);
  return { ...config, [IMAGE_SETTINGS_KEY]: images };
}
