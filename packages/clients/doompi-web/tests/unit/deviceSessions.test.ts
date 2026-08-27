import { describe, expect, it } from 'vitest';
import {
  type DeviceRecord,
  cookieMaxAgeSeconds,
  deviceLabelFor,
  evaluateDevice,
  sanitizeEdgeIp,
  sanitizeUserAgent,
  touchDevice,
} from '../../src/services/deviceSessions.ts';
import { DEFAULT_REMOTE_SETTINGS } from '../../src/services/remoteAccessSettings.ts';
import { COOKIE_CEILING_SECONDS, type RemoteAccessSettings } from '../../src/types/remoteAccess.ts';

const MINUTE = 60_000;
const HOUR = 3_600_000;
const START = 1_700_000_000_000;

function device(overrides: Partial<DeviceRecord> = {}): DeviceRecord {
  return {
    id: 'device-1',
    tokenHash: 'a'.repeat(64),
    label: 'iPhone · Safari',
    userAgent: 'test agent',
    createdAt: START,
    lastSeenAt: START,
    ...overrides,
  };
}

/** Expiry is off by default, so a test about expiry has to ask for it. */
function settings(overrides: Partial<RemoteAccessSettings> = {}): RemoteAccessSettings {
  return { ...DEFAULT_REMOTE_SETTINGS, sessionExpiryEnabled: true, ...overrides };
}

describe('the shipped defaults', () => {
  it('leaves both time limits off', () => {
    // A deliberate choice: with these off a tunnel lasts until it is closed and
    // a session until it is revoked, so switching remote access off is the only
    // expiry there is.
    expect(DEFAULT_REMOTE_SETTINGS.autoCloseEnabled).toBe(false);
    expect(DEFAULT_REMOTE_SETTINGS.sessionExpiryEnabled).toBe(false);
  });

  it('keeps usable durations behind the switches', () => {
    expect(DEFAULT_REMOTE_SETTINGS.autoCloseMinutes).toBe(60);
    expect(DEFAULT_REMOTE_SETTINGS.idleMinutes).toBe(30);
    expect(DEFAULT_REMOTE_SETTINGS.absoluteHours).toBe(12);
  });

  it('never expires a session while the switch is off', () => {
    const ancient = device({ createdAt: 0, lastSeenAt: 0 });
    expect(evaluateDevice(ancient, START + 400 * HOUR, DEFAULT_REMOTE_SETTINGS)).toMatchObject({ ok: true });
  });
});

describe('evaluateDevice', () => {
  it('rejects a token that names no device', () => {
    expect(evaluateDevice(undefined, START, settings())).toEqual({ ok: false, reason: 'unknown' });
  });

  it('accepts a device seen just now', () => {
    expect(evaluateDevice(device(), START + MINUTE, settings())).toMatchObject({ ok: true });
  });

  it('rejects a device idle past the limit', () => {
    expect(evaluateDevice(device(), START + 31 * MINUTE, settings())).toEqual({ ok: false, reason: 'idle' });
  });

  it('rejects a device past its absolute age even while active', () => {
    const active = device({ lastSeenAt: START + 13 * HOUR });
    expect(evaluateDevice(active, START + 13 * HOUR, settings())).toEqual({ ok: false, reason: 'absolute' });
  });

  it('revives an already-idle device the moment expiry is switched off', () => {
    // The point of deriving expiry at evaluation time rather than stamping it
    // on the record: the toggle has to work in both directions, retroactively.
    const idle = device();
    const later = START + 31 * MINUTE;
    expect(evaluateDevice(idle, later, settings({ sessionExpiryEnabled: true }))).toMatchObject({ ok: false });
    expect(evaluateDevice(idle, later, settings({ sessionExpiryEnabled: false }))).toMatchObject({ ok: true });
  });

  it('invalidates an already-idle device the moment expiry is switched on', () => {
    const idle = device();
    const later = START + 31 * MINUTE;
    expect(evaluateDevice(idle, later, settings({ sessionExpiryEnabled: false }))).toMatchObject({ ok: true });
    expect(evaluateDevice(idle, later, settings({ sessionExpiryEnabled: true }))).toMatchObject({ ok: false });
  });

  it('extends the idle window when the device is touched', () => {
    const seen = touchDevice(device(), START + 20 * MINUTE);
    expect(evaluateDevice(seen, START + 45 * MINUTE, settings())).toMatchObject({ ok: true });
  });
});

describe('cookieMaxAgeSeconds', () => {
  it('matches the absolute expiry while expiry is on', () => {
    expect(cookieMaxAgeSeconds(settings({ absoluteHours: 12 }), COOKIE_CEILING_SECONDS)).toBe(12 * 3600);
  });

  it('falls back to the ceiling rather than omitting a lifetime entirely', () => {
    // A session cookie can outlive the laptop on mobile Safari, so there is
    // always a Max-Age even when the server has stopped expiring sessions.
    expect(cookieMaxAgeSeconds(settings({ sessionExpiryEnabled: false }), COOKIE_CEILING_SECONDS)).toBe(
      COOKIE_CEILING_SECONDS,
    );
  });

  it('never exceeds the ceiling', () => {
    expect(cookieMaxAgeSeconds(settings({ absoluteHours: 720 }), COOKIE_CEILING_SECONDS)).toBe(COOKIE_CEILING_SECONDS);
  });
});

describe('sanitizeUserAgent', () => {
  it('strips the newlines that would forge a second log line', () => {
    expect(sanitizeUserAgent('Mozilla/5.0\r\n[doompi-web] pairing approved')).toBe(
      'Mozilla/5.0 [doompi-web] pairing approved',
    );
  });

  it('strips C0 and C1 control characters', () => {
    expect(sanitizeUserAgent('a\u0000b\u001Fc\u007Fd\u009Fe')).toBe('a b c d e');
  });

  it('truncates a padded agent', () => {
    expect(sanitizeUserAgent('x'.repeat(500))).toHaveLength(200);
  });

  it('leaves an ordinary agent untouched', () => {
    expect(sanitizeUserAgent('Mozilla/5.0 (iPhone) Safari/604.1')).toBe('Mozilla/5.0 (iPhone) Safari/604.1');
  });

  it('names the unknown rather than rendering an empty row', () => {
    expect(sanitizeUserAgent(undefined)).toBe('unknown device');
    expect(sanitizeUserAgent('   ')).toBe('unknown device');
  });
});

describe('sanitizeEdgeIp', () => {
  it('keeps a plain v4 or v6 address', () => {
    expect(sanitizeEdgeIp('203.0.113.7')).toBe('203.0.113.7');
    expect(sanitizeEdgeIp('2001:db8::1')).toBe('2001:db8::1');
  });

  it('takes only the first hop of a forwarded chain', () => {
    expect(sanitizeEdgeIp('203.0.113.7, 198.51.100.2')).toBe('203.0.113.7');
  });

  it('handles an empty forwarded chain', () => {
    expect(sanitizeEdgeIp('')).toBe('unknown');
    expect(sanitizeEdgeIp(',')).toBe('unknown');
  });

  it('refuses anything that is not address-shaped', () => {
    expect(sanitizeEdgeIp('1.2.3.4\nFAKE LOG LINE')).toBe('unknown');
    expect(sanitizeEdgeIp('<script>')).toBe('unknown');
    expect(sanitizeEdgeIp(undefined)).toBe('unknown');
  });
});

describe('cookieMaxAgeSeconds rounding', () => {
  it('rounds a fractional hour to whole seconds', () => {
    expect(cookieMaxAgeSeconds(settings({ absoluteHours: 1 }), COOKIE_CEILING_SECONDS)).toBe(3600);
  });
});

describe('deviceLabelFor', () => {
  it.each([
    ['Mozilla/5.0 (iPhone; CPU iPhone OS 17_0) AppleWebKit/605 Version/17.0 Mobile Safari/604.1', 'iPhone · Safari'],
    ['Mozilla/5.0 (Linux; Android 14) AppleWebKit/537 Chrome/120.0 Mobile Safari/537', 'Android · Chrome'],
    ['Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537 Chrome/120.0 Safari/537', 'Mac · Chrome'],
    ['Mozilla/5.0 (Windows NT 10.0) Gecko/20100101 Firefox/121.0', 'Windows · Firefox'],
  ])('reads %s as %s', (agent, expected) => {
    expect(deviceLabelFor(agent)).toBe(expected);
  });

  it('names a device it recognises without a browser', () => {
    expect(deviceLabelFor('Mozilla/5.0 (iPad)')).toBe('iPad');
  });

  it('names a browser it recognises without a device', () => {
    expect(deviceLabelFor('Chrome/120.0')).toBe('Chrome');
  });

  it('falls back rather than inventing a device', () => {
    expect(deviceLabelFor('curl/8.4.0')).toBe('paired device');
  });
});
