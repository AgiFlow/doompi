import { afterEach, describe, expect, it, vi } from 'vitest';
import { createDeviceAuth } from '../../src/adapters/deviceAuth.ts';
import { DEFAULT_REMOTE_SETTINGS } from '../../src/services/remoteAccessSettings.ts';
import type { RemoteAccessSettings } from '../../src/types/remoteAccess.ts';

const START = 1_700_000_000_000;
const MINUTE = 60_000;
const AGENT = 'Mozilla/5.0 (iPhone) Safari/604.1';

function auth(overrides: Partial<RemoteAccessSettings> = {}) {
  let now = START;
  const notices: string[] = [];
  const dropped: Array<{ id: string; reason: 'revoked' | 'expired' }> = [];
  const settings: RemoteAccessSettings = { ...DEFAULT_REMOTE_SETTINGS, ...overrides };
  const devices = createDeviceAuth({
    settings: () => settings,
    now: () => now,
    onNotice: (message) => notices.push(message),
    onDrop: (record, reason) => dropped.push({ id: record.id, reason }),
  });
  return {
    devices,
    notices,
    dropped,
    advance: (ms: number) => (now += ms),
    update: (patch: Partial<RemoteAccessSettings>) => Object.assign(settings, patch),
  };
}

afterEach(() => vi.useRealTimers());
describe('createDeviceAuth', () => {
  it('hands back a token once and keeps only its digest', () => {
    const { devices } = auth();
    const { token, record } = devices.enrol({ userAgent: AGENT });
    expect(token).toHaveLength(43);
    // The record is what persists and what the UI reads; it must never carry
    // anything that would let a reader impersonate the device.
    expect(JSON.stringify(record)).not.toContain(token);
    expect(record.tokenHash).toMatch(/^[0-9a-f]{64}$/u);
  });

  it('gives every device a different token', () => {
    const { devices } = auth();
    expect(devices.enrol({ userAgent: AGENT }).token).not.toBe(devices.enrol({ userAgent: AGENT }).token);
  });

  it('recognises its own token and nothing else', () => {
    const { devices } = auth();
    const { token, record } = devices.enrol({ userAgent: AGENT });
    expect(devices.verify(token)?.id).toBe(record.id);
    expect(devices.verify('some other token')).toBeUndefined();
    expect(devices.verify(undefined)).toBeUndefined();
    expect(devices.verify('')).toBeUndefined();
  });

  it('bumps last seen so an active device does not go idle', () => {
    const { devices, advance } = auth();
    const { token } = devices.enrol({ userAgent: AGENT });
    advance(20 * MINUTE);
    expect(devices.verify(token)).toBeDefined();
    advance(20 * MINUTE);
    // Still valid: the check at 20 minutes reset the idle clock.
    expect(devices.verify(token)).toBeDefined();
  });

  it('drops an expired device on the way past rather than leaving it listed', () => {
    const { devices, dropped, advance } = auth({ sessionExpiryEnabled: true, idleMinutes: 5 });
    const { token, record } = devices.enrol({ userAgent: AGENT });
    advance(6 * MINUTE);
    expect(devices.verify(token)).toBeUndefined();
    expect(devices.list()).toHaveLength(0);
    expect(dropped).toEqual([{ id: record.id, reason: 'expired' }]);
  });

  it('drops a device at its exact idle deadline without another request', () => {
    vi.useFakeTimers();
    const { devices, dropped, advance } = auth({ sessionExpiryEnabled: true, idleMinutes: 5 });
    const { record } = devices.enrol({ userAgent: AGENT });

    advance(5 * MINUTE);
    vi.advanceTimersByTime(5 * MINUTE);

    expect(devices.list()).toEqual([]);
    expect(dropped).toEqual([{ id: record.id, reason: 'expired' }]);
  });

  it('applies a shortened expiry setting immediately', () => {
    const { devices, dropped, advance, update } = auth({ sessionExpiryEnabled: true, idleMinutes: 30 });
    const { record } = devices.enrol({ userAgent: AGENT });
    advance(10 * MINUTE);

    update({ idleMinutes: 5 });
    devices.reschedule();

    expect(devices.list()).toEqual([]);
    expect(dropped).toEqual([{ id: record.id, reason: 'expired' }]);
  });
  it('revokes one device by id and leaves the rest', () => {
    const { devices, notices, dropped } = auth();
    const first = devices.enrol({ userAgent: AGENT });
    const second = devices.enrol({ userAgent: AGENT });
    expect(devices.revoke(first.record.id)).toBe(true);
    expect(devices.revoke('no such device')).toBe(false);
    expect(devices.verify(first.token)).toBeUndefined();
    expect(devices.verify(second.token)).toBeDefined();
    expect(notices.some((message) => message.startsWith('revoked'))).toBe(true);
    expect(dropped).toEqual([{ id: first.record.id, reason: 'revoked' }]);
  });

  it('revokes everything when remote access is switched off', () => {
    const { devices } = auth();
    const first = devices.enrol({ userAgent: AGENT });
    devices.enrol({ userAgent: AGENT });
    expect(devices.revokeAll()).toBe(2);
    expect(devices.list()).toHaveLength(0);
    expect(devices.verify(first.token)).toBeUndefined();
    expect(devices.revokeAll()).toBe(0);
  });

  it('sweeps what has aged out and keeps what has not', () => {
    const { devices, advance } = auth({ sessionExpiryEnabled: true, idleMinutes: 5 });
    devices.enrol({ userAgent: AGENT });
    advance(6 * MINUTE);
    const fresh = devices.enrol({ userAgent: AGENT });
    expect(devices.sweep()).toBe(1);
    expect(devices.list().map((record) => record.id)).toEqual([fresh.record.id]);
  });

  it('labels a device from its agent and keeps the full string alongside', () => {
    const { devices } = auth();
    const { record } = devices.enrol({ userAgent: AGENT });
    expect(record.label).toBe('iPhone · Safari');
    expect(record.userAgent).toBe(AGENT);
  });
});
