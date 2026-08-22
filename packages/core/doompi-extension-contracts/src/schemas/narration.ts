import type { Context } from '@deepseek-ai/cordis';
import { type Static, Type } from 'typebox';
import { Check } from 'typebox/value';

/** Voice-owned Cordis service for caller-authored narration requests. */
export const DOOM_NARRATION_SERVICE = 'doom/narration';
/** Stable provider identity used when consumers pair narration with the mode catalog. */
export const DOOM_VOICE_SOURCE = '@agimon-ai/doompi-voice';
/** Stable mode identity for autonomous narration. */
export const DOOM_VOICE_AUTO_MODE_ID = 'voice-auto';
export const MAX_NARRATION_TEXT_CHARACTERS = 4_096;

export const NarrationRequestSchema = Type.Object(
  {
    text: Type.String({ minLength: 1, maxLength: MAX_NARRATION_TEXT_CHARACTERS }),
  },
  { additionalProperties: false },
);

export type NarrationRequest = Static<typeof NarrationRequestSchema>;

/** Generic outbound speech seam. The provider owns delivery and lifecycle. */
export interface DoomNarrationService {
  readonly generation: string;
  request(request: NarrationRequest): void | Promise<void>;
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    'doom/narration': DoomNarrationService;
  }
}

function replaceControlCharacters(text: string): string {
  return Array.from(text, (character) => {
    const codePoint = character.codePointAt(0);
    return codePoint !== undefined && (codePoint < 0x20 || codePoint === 0x7f) ? ' ' : character;
  }).join('');
}

/** Normalize caller-owned speech while preserving Unicode-safe truncation. */
export function normalizeNarrationText(text: string): string | undefined {
  const normalized = replaceControlCharacters(text).replace(/\s+/gu, ' ').trim();
  if (!normalized) return undefined;

  let truncated = '';
  for (const character of normalized) {
    if (truncated.length + character.length > MAX_NARRATION_TEXT_CHARACTERS) break;
    truncated += character;
  }
  return truncated;
}

/** Builds the validated request value consumers pass to the injected service. */
export function createNarrationRequest(text: string): NarrationRequest | undefined {
  const normalized = normalizeNarrationText(text);
  return normalized === undefined ? undefined : Object.freeze({ text: normalized });
}

export function isNarrationRequest(value: unknown): value is NarrationRequest {
  return Check(NarrationRequestSchema, value);
}

export function readDoomNarrationService(context: Context): DoomNarrationService | undefined {
  return context.get(DOOM_NARRATION_SERVICE) as DoomNarrationService | undefined;
}

export function requireDoomNarrationService(context: Context): DoomNarrationService {
  const service = readDoomNarrationService(context);
  if (!service) throw new Error('Doom narration is unavailable. Load @agimon-ai/doompi-voice.');
  return service;
}
