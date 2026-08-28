import type { Context } from '@deepseek-ai/cordis';
import { type Static, Type } from 'typebox';
import { Check } from 'typebox/value';

/** Provider-owned Cordis service for caller-authored notification requests. */
export const DOOM_NOTIFICATION_SERVICE = 'doom/notification';
/** Custom session entry type used to publish normalized notification data. */
export const DOOM_NOTIFICATION_ENTRY_TYPE = 'doom-notification';
export const DOOM_NOTIFICATION_ENTRY_VERSION = 1 as const;
export const MAX_DOOM_NOTIFICATION_TITLE_CHARACTERS = 128;
export const MAX_DOOM_NOTIFICATION_SUBTITLE_CHARACTERS = 256;
export const MAX_DOOM_NOTIFICATION_BODY_CHARACTERS = 4_096;

export const DoomNotificationLevelSchema = Type.Union([
  Type.Literal('info'),
  Type.Literal('warning'),
  Type.Literal('error'),
]);
export type DoomNotificationLevel = Static<typeof DoomNotificationLevelSchema>;

export const DoomNotificationRequestSchema = Type.Object(
  {
    title: Type.Optional(Type.String({ minLength: 1, maxLength: MAX_DOOM_NOTIFICATION_TITLE_CHARACTERS })),
    subtitle: Type.Optional(Type.String({ minLength: 1, maxLength: MAX_DOOM_NOTIFICATION_SUBTITLE_CHARACTERS })),
    body: Type.String({ minLength: 1, maxLength: MAX_DOOM_NOTIFICATION_BODY_CHARACTERS }),
    level: Type.Optional(DoomNotificationLevelSchema),
  },
  { additionalProperties: false },
);
export type DoomNotificationRequest = Static<typeof DoomNotificationRequestSchema>;

const NormalizableDoomNotificationRequestSchema = Type.Object(
  {
    title: Type.Optional(Type.String()),
    subtitle: Type.Optional(Type.String()),
    body: Type.String(),
    level: Type.Optional(DoomNotificationLevelSchema),
  },
  { additionalProperties: false },
);

export const DoomNotificationEntryDataSchema = Type.Object(
  {
    version: Type.Literal(DOOM_NOTIFICATION_ENTRY_VERSION),
    title: Type.String({ maxLength: MAX_DOOM_NOTIFICATION_TITLE_CHARACTERS }),
    subtitle: Type.String({ maxLength: MAX_DOOM_NOTIFICATION_SUBTITLE_CHARACTERS }),
    body: Type.String({ minLength: 1, maxLength: MAX_DOOM_NOTIFICATION_BODY_CHARACTERS }),
    level: DoomNotificationLevelSchema,
  },
  { additionalProperties: false },
);
export type DoomNotificationEntryData = Static<typeof DoomNotificationEntryDataSchema>;

/** Generic outbound notification seam. The provider owns delivery and lifecycle. */
export interface DoomNotificationService {
  readonly generation: string;
  request(request: DoomNotificationRequest): void | Promise<void>;
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    'doom/notification': DoomNotificationService;
  }
}

function replaceControlCharacters(text: string): string {
  return Array.from(text, (character) => {
    const codePoint = character.codePointAt(0);
    return codePoint !== undefined && (codePoint < 0x20 || codePoint === 0x7f) ? ' ' : character;
  }).join('');
}

function normalizeText(text: string, maximum: number): string | undefined {
  const normalized = replaceControlCharacters(text).replace(/\s+/gu, ' ').trim();
  if (!normalized) return undefined;

  let truncated = '';
  for (const character of normalized) {
    if (truncated.length + character.length > maximum) break;
    truncated += character;
  }
  return truncated;
}

/** Normalize caller-owned notification text into a validated request. */
export function normalizeDoomNotificationRequest(request: unknown): DoomNotificationRequest | undefined {
  if (!Check(NormalizableDoomNotificationRequestSchema, request)) return undefined;

  const body = normalizeText(request.body, MAX_DOOM_NOTIFICATION_BODY_CHARACTERS);
  if (!body) return undefined;
  const title = request.title && normalizeText(request.title, MAX_DOOM_NOTIFICATION_TITLE_CHARACTERS);
  const subtitle = request.subtitle && normalizeText(request.subtitle, MAX_DOOM_NOTIFICATION_SUBTITLE_CHARACTERS);
  const normalized = {
    body,
    ...(title ? { title } : {}),
    ...(subtitle ? { subtitle } : {}),
    ...(request.level ? { level: request.level } : {}),
  };
  return Object.freeze(normalized);
}

/** Builds normalized, versioned data for a Doom notification session entry. */
export function createDoomNotificationEntryData(request: unknown): DoomNotificationEntryData | undefined {
  const normalized = normalizeDoomNotificationRequest(request);
  if (!normalized) return undefined;
  return Object.freeze({
    version: DOOM_NOTIFICATION_ENTRY_VERSION,
    title: normalized.title ?? '',
    subtitle: normalized.subtitle ?? '',
    body: normalized.body,
    level: normalized.level ?? 'info',
  });
}

export function isDoomNotificationRequest(value: unknown): value is DoomNotificationRequest {
  return Check(DoomNotificationRequestSchema, value);
}

export function isDoomNotificationEntryData(value: unknown): value is DoomNotificationEntryData {
  return Check(DoomNotificationEntryDataSchema, value);
}

export function readDoomNotificationService(context: Context): DoomNotificationService | undefined {
  return context.get(DOOM_NOTIFICATION_SERVICE) as DoomNotificationService | undefined;
}

export function requireDoomNotificationService(context: Context): DoomNotificationService {
  const service = readDoomNotificationService(context);
  if (!service) throw new Error('Doom notification is unavailable. Load a notification provider.');
  return service;
}
