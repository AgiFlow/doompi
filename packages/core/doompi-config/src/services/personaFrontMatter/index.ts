import { parse as parseYaml } from 'yaml';

import type { PersonaDocument, PersonaFrontMatter, PersonaVoiceOverride } from '../../types/profiles';

/**
 * Optional identity a persona declares at the top of its `profile.md`.
 *
 * A profile used to be prompt text only, so there was nowhere to say who the
 * persona is or how it should sound. Front-matter puts that beside the persona
 * text it describes, which is the only place that works for both explicit
 * `profiles.yaml` entries and folders found by root discovery.
 *
 * Recognition is deliberately narrow. Personas that exist today were written
 * without any of this, and one of them may legitimately open with a horizontal
 * rule, so a leading fence alone is not enough to claim the block. A block is
 * only treated as identity when it is fenced at the very first line, closed,
 * parses as a mapping, and declares at least one field this contract owns.
 * Anything else is passed through byte for byte.
 */

const FENCE = '---';
const OWNED_KEYS = ['name', 'icon', 'voice'] as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function readVoice(value: unknown): PersonaVoiceOverride | undefined {
  if (!isRecord(value)) return undefined;
  const voice = typeof value.voice === 'string' && value.voice.trim().length > 0 ? value.voice.trim() : undefined;
  const rate = typeof value.rate === 'number' && Number.isFinite(value.rate) ? value.rate : undefined;
  if (voice === undefined && rate === undefined) return undefined;
  return { ...(voice === undefined ? {} : { voice }), ...(rate === undefined ? {} : { rate }) };
}

function readFrontMatter(parsed: Record<string, unknown>): PersonaFrontMatter | undefined {
  const name = typeof parsed.name === 'string' && parsed.name.trim().length > 0 ? parsed.name.trim() : undefined;
  const icon = typeof parsed.icon === 'string' && parsed.icon.trim().length > 0 ? parsed.icon.trim() : undefined;
  const voice = readVoice(parsed.voice);
  if (name === undefined && icon === undefined && voice === undefined) return undefined;
  return {
    ...(name === undefined ? {} : { name }),
    ...(icon === undefined ? {} : { icon }),
    ...(voice === undefined ? {} : { voice }),
  };
}

/**
 * Splits a recognised identity block off a persona document.
 *
 * Never throws: a malformed avatar must not make a persona unloadable, so an
 * unparseable or unrecognised block leaves the document exactly as it arrived.
 */
export function parsePersonaFrontMatter(content: string): PersonaDocument {
  const lines = content.split('\n');
  if (lines[0]?.trimEnd() !== FENCE) return { body: content };

  const closingIndex = lines.findIndex((line, index) => index > 0 && line.trimEnd() === FENCE);
  if (closingIndex === -1) return { body: content };

  let parsed: unknown;
  try {
    parsed = parseYaml(lines.slice(1, closingIndex).join('\n'));
  } catch {
    return { body: content };
  }
  if (!isRecord(parsed)) return { body: content };
  if (!OWNED_KEYS.some((key) => Object.hasOwn(parsed, key))) return { body: content };

  const frontMatter = readFrontMatter(parsed);
  if (!frontMatter) return { body: content };
  return { frontMatter, body: lines.slice(closingIndex + 1).join('\n') };
}
