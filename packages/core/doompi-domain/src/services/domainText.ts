import type { DoomTransitionResult } from '@agimon-ai/doompi-extension-contracts/transition';
import {
  VOICE_TOOL_MAX_DOMAIN_COUNT,
  VOICE_TOOL_MAX_IDENTIFIER_LENGTH,
} from '@agimon-ai/doompi-extension-contracts/voice-tools';
import type { SelectItem } from '@earendil-works/pi-tui';
import { type DomainListing, SAFE_DOMAIN_NAME } from '../types/domains.ts';

const DOMAIN_SEPARATOR = ',';
export const DOMAIN_COMMAND = 'domains';
export const VOICE_SWITCH_TOKEN_PREFIX = '--voice-switch-token=';
/** What an empty selection reads as, which is a real state rather than an error. */
export const NONE = '(none)';

/** Splits the comma-separated argument the command and the autocomplete share. */
export function splitDomains(value: string): string[] {
  return value
    .split(DOMAIN_SEPARATOR)
    .map((item) => item.trim())
    .filter(Boolean);
}

/** Picker rows for the domain multi-select. */
export function domainItems(
  names: string[],
  descriptions: Readonly<Record<string, string | undefined>> = {},
): SelectItem[] {
  return names.map((name) => ({
    value: name,
    label: name,
    ...(descriptions[name] ? { description: descriptions[name] } : {}),
  }));
}

export function domainSummary(listing: DomainListing): string {
  const active = listing.effective.join(', ') || NONE;
  return `Active domains: ${active}\nAvailable domains: ${listing.available.join(', ')}\nUse /${DOMAIN_COMMAND} <name[,name...]> to switch.`;
}

export function switchedSummary(domains: readonly string[]): string {
  return `Switched domains to: ${domains.join(', ') || NONE}`;
}

export function unchangedSummary(domains: readonly string[]): string {
  return `Domains already active: ${domains.join(', ') || NONE}`;
}

export function pickerTitle(listing: DomainListing): string {
  return `Domains (active: ${listing.effective.join(', ') || NONE})`;
}

/**
 * Deduplicates a requested selection and rejects anything unsafe.
 *
 * Bounded before the manifest is read, because a selection large enough to
 * matter comes from the model rather than from a person typing the command.
 */
export function normalizeDomainNames(values: readonly string[]): string[] {
  if (values.length > VOICE_TOOL_MAX_DOMAIN_COUNT) {
    throw new Error(`A maximum of ${VOICE_TOOL_MAX_DOMAIN_COUNT} domains may be selected.`);
  }
  const result: string[] = [];
  const seen = new Set<string>();
  for (const value of values) {
    const name = value.trim();
    if (!name || name.length > VOICE_TOOL_MAX_IDENTIFIER_LENGTH || !SAFE_DOMAIN_NAME.test(name)) {
      throw new Error(`Invalid domain name: ${value}`);
    }
    if (seen.has(name)) continue;
    seen.add(name);
    result.push(name);
  }
  return result;
}

/** The opaque token a voice switch hands to the follow-up command invocation. */
export function voiceSwitchToken(args: string): string | undefined {
  const trimmed = args.trim();
  if (!trimmed.startsWith(VOICE_SWITCH_TOKEN_PREFIX)) return undefined;
  const parts = trimmed.split(/\s+/u);
  if (parts.length !== 1) throw new Error('The voice domain switch token must be the only command argument.');
  const token = parts[0]?.slice(VOICE_SWITCH_TOKEN_PREFIX.length).trim();
  if (!token) throw new Error('The voice domain switch token is missing.');
  return token;
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function transitionError(result: DoomTransitionResult): Error {
  return new Error(`Domain transition was ${result.outcome}: ${result.diagnostics.join(', ')}`);
}
