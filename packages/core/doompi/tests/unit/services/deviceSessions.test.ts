import { describe, expect, it } from 'vitest';
import {
  cookieMaxAgeSeconds,
  deviceExpiryAt,
  deviceLabelFor,
  evaluateDevice,
  sanitizeEdgeIp,
  sanitizeUserAgent,
  touchDevice,
} from '../../../src/services/deviceSessions';
import { DEFAULT_REMOTE_SETTINGS } from '../../../src/services/remoteAccessSettings';

const record = { id: 'one', tokenHash: 'hash', label: 'Phone', userAgent: 'Phone', createdAt: 0, lastSeenAt: 60_000 };
const expiring = { ...DEFAULT_REMOTE_SETTINGS, sessionExpiryEnabled: true, idleMinutes: 2, absoluteHours: 1 };

describe('device sessions', () => {
  it('applies current idle and absolute expiry settings to existing sessions', () => {
    expect(evaluateDevice(undefined, 0, expiring)).toEqual({ ok: false, reason: 'unknown' });
    expect(evaluateDevice(record, 999_999, DEFAULT_REMOTE_SETTINGS)).toEqual({ ok: true, record });
    expect(evaluateDevice(record, 60_000 + 2 * 60_000, expiring)).toEqual({ ok: false, reason: 'idle' });
    expect(evaluateDevice(record, 3_600_000, { ...expiring, idleMinutes: 100 })).toEqual({
      ok: false,
      reason: 'absolute',
    });
    expect(evaluateDevice(record, 61_000, expiring)).toEqual({ ok: true, record });
    expect(deviceExpiryAt(record, DEFAULT_REMOTE_SETTINGS)).toBeUndefined();
    expect(deviceExpiryAt(record, expiring)).toBe(180_000);
    expect(touchDevice(record, 90_000)).toMatchObject({ lastSeenAt: 90_000, createdAt: 0 });
    expect(cookieMaxAgeSeconds(DEFAULT_REMOTE_SETTINGS, 5000)).toBe(5000);
    expect(cookieMaxAgeSeconds(expiring, 5000)).toBe(3600);
  });

  it('sanitizes attacker-supplied labels and edge addresses', () => {
    expect(sanitizeUserAgent(undefined)).toBe('unknown device');
    expect(sanitizeUserAgent('\u0000\n\u0080')).toBe('unknown device');
    expect(sanitizeUserAgent('  iPhone\n  Safari/17  ')).toBe('iPhone Safari/17');
    expect(sanitizeUserAgent('x'.repeat(300))).toHaveLength(200);
    expect(sanitizeEdgeIp(undefined)).toBe('unknown');
    expect(sanitizeEdgeIp(' 192.0.2.1, spoofed')).toBe('192.0.2.1');
    expect(sanitizeEdgeIp('192.0.2.1\nforged')).toBe('unknown');
    expect(deviceLabelFor('iPhone Edg/100 Safari/17')).toBe('iPhone · Edge');
    expect(deviceLabelFor('Macintosh Firefox/100')).toBe('Mac · Firefox');
    expect(deviceLabelFor('Android Chrome/100')).toBe('Android · Chrome');
    expect(deviceLabelFor('Safari/17')).toBe('Safari');
    expect(deviceLabelFor('mystery')).toBe('paired device');
  });
});
