/**
 * What makes a paired device's session still valid.
 *
 * Expiry is derived from the settings in force at the moment of the check,
 * never stamped onto the record when it was minted. That is what makes the
 * setting honest in both directions: switching expiry on has to invalidate a
 * session that is already idle, and switching it off has to bring it back. A
 * stored `expiresAt` would do neither.
 */

import type { RemoteAccessSettings } from '../types/remoteAccess.ts';

const MS_PER_MINUTE = 60_000;
const MS_PER_HOUR = 3_600_000;
const MS_PER_SECOND = 1000;
/** Long enough to tell an iPhone from a laptop, short enough not to be a fingerprint in a log. */
const MAX_USER_AGENT = 200;
/** Upper bound of the C0 block, and the bounds of C1. Codepoints rather than a character class:
 * a regex over control characters is unreadable, hard to review, and trips no-control-regex. */
const C0_END = 0x1f;
const C1_START = 0x7f;
const C1_END = 0x9f;
const UNKNOWN_DEVICE = 'unknown device';

export interface DeviceRecord {
  /** Opaque, safe to display and to name in a revoke call. Never the secret. */
  id: string;
  /** SHA-256 of the session token. The token itself is never retained. */
  tokenHash: string;
  label: string;
  userAgent: string;
  /** Epoch milliseconds. */
  createdAt: number;
  /** Epoch milliseconds, bumped on every authenticated request. */
  lastSeenAt: number;
}

export type DeviceRejection = 'unknown' | 'idle' | 'absolute';

export type DeviceVerdict = { ok: true; record: DeviceRecord } | { ok: false; reason: DeviceRejection };

/** Whether this record still authorizes a request, under the settings in force right now. */
export function evaluateDevice(
  record: DeviceRecord | undefined,
  now: number,
  settings: RemoteAccessSettings,
): DeviceVerdict {
  if (record === undefined) return { ok: false, reason: 'unknown' };
  if (!settings.sessionExpiryEnabled) return { ok: true, record };
  if (now - record.lastSeenAt >= settings.idleMinutes * MS_PER_MINUTE) return { ok: false, reason: 'idle' };
  if (now - record.createdAt >= settings.absoluteHours * MS_PER_HOUR) return { ok: false, reason: 'absolute' };
  return { ok: true, record };
}

/** Exact deadline at which this device stops authorizing, or undefined while expiry is disabled. */
export function deviceExpiryAt(record: DeviceRecord, settings: RemoteAccessSettings): number | undefined {
  if (!settings.sessionExpiryEnabled) return undefined;
  return Math.min(
    record.lastSeenAt + settings.idleMinutes * MS_PER_MINUTE,
    record.createdAt + settings.absoluteHours * MS_PER_HOUR,
  );
}

export function touchDevice(record: DeviceRecord, now: number): DeviceRecord {
  return { ...record, lastSeenAt: now };
}

/** How long the cookie should live, so the browser forgets roughly when the server does. */
export function cookieMaxAgeSeconds(settings: RemoteAccessSettings, ceilingSeconds: number): number {
  if (!settings.sessionExpiryEnabled) return ceilingSeconds;
  return Math.min(ceilingSeconds, Math.round((settings.absoluteHours * MS_PER_HOUR) / MS_PER_SECOND));
}

/** Replaces every C0 and C1 control character with a space; those are what could forge a log line. */
function withoutControlCharacters(value: string): string {
  let out = '';
  for (const character of value) {
    const code = character.codePointAt(0) ?? 0;
    out += code <= C0_END || (code >= C1_START && code <= C1_END) ? ' ' : character;
  }
  return out;
}

/**
 * Strips anything that could forge a second line in a log or a second element
 * in the approval dialog, then truncates.
 *
 * The user agent is attacker-supplied and lands in both `notice()` output and
 * the host's approval prompt, so control characters are the concern rather than
 * length.
 */
export function sanitizeUserAgent(raw: string | undefined): string {
  if (raw === undefined) return UNKNOWN_DEVICE;
  const stripped = withoutControlCharacters(raw).replaceAll(/\s+/gu, ' ').trim();
  if (stripped === '') return UNKNOWN_DEVICE;
  return stripped.slice(0, MAX_USER_AGENT);
}

/**
 * The address Cloudflare's edge reported, reduced to a safe display and key value.
 *
 * It never authorizes a request. The tunnel route may use it only for abuse
 * throttling when Cloudflare is the trusted proxy. A local process can forge it,
 * but local processes are outside that public-internet boundary.
 */
export function sanitizeEdgeIp(raw: string | undefined): string {
  if (raw === undefined) return 'unknown';
  const candidate = raw.split(',')[0]?.trim() ?? '';
  return /^[0-9a-f:.]{1,45}$/iu.test(candidate) ? candidate : 'unknown';
}

const DEVICE_HINTS: readonly { pattern: RegExp; label: string }[] = [
  { pattern: /iphone/iu, label: 'iPhone' },
  { pattern: /ipad/iu, label: 'iPad' },
  { pattern: /android/iu, label: 'Android' },
  { pattern: /macintosh|mac os x/iu, label: 'Mac' },
  { pattern: /windows/iu, label: 'Windows' },
  { pattern: /linux/iu, label: 'Linux' },
];

const BROWSER_HINTS: readonly { pattern: RegExp; label: string }[] = [
  // Order matters: every Chromium user agent also says Safari, and Edge says both.
  { pattern: /edg\//iu, label: 'Edge' },
  { pattern: /firefox\//iu, label: 'Firefox' },
  { pattern: /chrome\/|crios\//iu, label: 'Chrome' },
  { pattern: /safari\//iu, label: 'Safari' },
];

/** A human label for the device list, best effort; the full user agent is shown alongside. */
export function deviceLabelFor(userAgent: string): string {
  const device = DEVICE_HINTS.find((hint) => hint.pattern.test(userAgent))?.label;
  const browser = BROWSER_HINTS.find((hint) => hint.pattern.test(userAgent))?.label;
  if (device !== undefined && browser !== undefined) return `${device} · ${browser}`;
  return device ?? browser ?? 'paired device';
}
