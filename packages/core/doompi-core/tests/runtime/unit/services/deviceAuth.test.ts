import { describe, expect, it, vi } from 'vitest';

import { createDeviceAuth } from '../../../../src/services/deviceAuth';
import { DEFAULT_REMOTE_SETTINGS } from '../../../../src/services/remoteAccessSettings';

describe('device auth', () => {
  it('stores only token digests, updates last seen, and revokes by opaque id', () => {
    let time = 1000;
    const notice = vi.fn();
    const onDrop = vi.fn();
    const auth = createDeviceAuth({
      settings: () => DEFAULT_REMOTE_SETTINGS,
      now: () => time,
      onNotice: notice,
      onDrop,
    });
    const enrolled = auth.enrol({ userAgent: 'iPhone Safari/17' });
    expect(enrolled.token).not.toBe(enrolled.record.tokenHash);
    expect(enrolled.record.label).toBe('iPhone · Safari');
    expect(auth.verify(undefined)).toBeUndefined();
    expect(auth.verify('')).toBeUndefined();
    expect(auth.verify('wrong')).toBeUndefined();
    time = 2000;
    expect(auth.verify(enrolled.token)?.lastSeenAt).toBe(2000);
    expect(auth.list()).toHaveLength(1);
    expect(auth.revoke('missing')).toBe(false);
    expect(auth.revoke(enrolled.record.id)).toBe(true);
    expect(auth.verify(enrolled.token)).toBeUndefined();
    expect(onDrop).toHaveBeenCalledWith(expect.objectContaining({ id: enrolled.record.id }), 'revoked');
    expect(notice).toHaveBeenCalledWith(expect.stringContaining('revoked iPhone'));
    expect(auth.revokeAll()).toBe(0);
  });

  it('honors settings changes on verify, sweep, and reschedule', () => {
    let time = 1000;
    let settings = DEFAULT_REMOTE_SETTINGS;
    const onDrop = vi.fn();
    const auth = createDeviceAuth({ settings: () => settings, now: () => time, onDrop });
    const first = auth.enrol({ userAgent: undefined });
    expect(auth.verify(first.token)).toMatchObject({ id: first.record.id });
    settings = { ...settings, sessionExpiryEnabled: true, idleMinutes: 1 };
    time = 61_000;
    expect(auth.verify(first.token)).toBeUndefined();
    expect(auth.list()).toEqual([]);
    expect(onDrop).toHaveBeenCalledWith(expect.objectContaining({ id: first.record.id }), 'expired');
    const second = auth.enrol({ userAgent: 'Laptop' });
    time = 122_000;
    expect(auth.sweep()).toBe(1);
    expect(auth.verify(second.token)).toBeUndefined();
    const third = auth.enrol({ userAgent: 'Phone' });
    settings = { ...settings, idleMinutes: 0 };
    auth.reschedule();
    expect(auth.list()).toEqual([]);
    expect(onDrop).toHaveBeenCalledWith(expect.objectContaining({ id: third.record.id }), 'expired');
  });

  it('revokes all devices and reports the count', () => {
    const notice = vi.fn();
    const onDrop = vi.fn();
    const auth = createDeviceAuth({ settings: () => DEFAULT_REMOTE_SETTINGS, onNotice: notice, onDrop });
    auth.enrol({ userAgent: 'Phone' });
    auth.enrol({ userAgent: 'Laptop' });
    expect(auth.revokeAll()).toBe(2);
    expect(auth.list()).toEqual([]);
    expect(onDrop).toHaveBeenCalledTimes(2);
    expect(notice).toHaveBeenCalledWith('revoked 2 paired device(s)');
  });
});
