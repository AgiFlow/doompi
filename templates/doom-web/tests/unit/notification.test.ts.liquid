import { afterEach, describe, expect, it, vi } from 'vitest';
import { parseDoomNotificationEntry } from '../../src/types/notification.ts';
import {
  browserNotificationPermission,
  deliverBrowserNotification,
  requestBrowserNotificationPermission,
} from '../../src/web/lib/browserNotifications.ts';

const data = {
  version: 1 as const,
  title: 'Build finished',
  subtitle: 'workspace',
  body: 'All checks passed.',
  level: 'info' as const,
};

class FakeNotification {
  static permission: NotificationPermission = 'granted';
  static requestPermission = vi.fn<() => Promise<NotificationPermission>>().mockResolvedValue('granted');
  static seen: Array<{ title: string; options?: NotificationOptions }> = [];

  constructor(title: string, options?: NotificationOptions) {
    FakeNotification.seen.push({ title, options });
  }
}

afterEach(() => {
  vi.unstubAllGlobals();
  FakeNotification.permission = 'granted';
  FakeNotification.requestPermission.mockReset().mockResolvedValue('granted');
  FakeNotification.seen = [];
});

describe('Doom notification entry parsing', () => {
  it('accepts only direct validated custom entry frames with a Pi entry id', () => {
    const valid = {
      type: 'entry_appended',
      entry: { id: 'pi/entry 1', type: 'custom', customType: 'doom-notification', data },
    };
    expect(parseDoomNotificationEntry(valid)).toEqual({ entryId: 'pi/entry 1', data });
    expect(parseDoomNotificationEntry({ type: 'replay', frame: valid })).toBeUndefined();
    expect(parseDoomNotificationEntry({ ...valid, entry: { ...valid.entry, id: '' } })).toBeUndefined();
    expect(parseDoomNotificationEntry({ ...valid, entry: { ...valid.entry, customType: 'other' } })).toBeUndefined();
    expect(
      parseDoomNotificationEntry({ ...valid, entry: { ...valid.entry, data: { ...data, extra: true } } }),
    ).toBeUndefined();
  });
});

describe('browser notification delivery', () => {
  it('delivers granted notifications with a stable encoded tag', () => {
    vi.stubGlobal('Notification', FakeNotification);

    expect(deliverBrowserNotification('session/a', 'pi entry/1', data)).toBe('delivered');
    expect(FakeNotification.seen).toEqual([
      {
        title: 'Build finished',
        options: { body: 'workspace\nAll checks passed.', tag: 'doompi:session%2Fa:pi%20entry%2F1' },
      },
    ]);
  });

  it('uses compact fallback copy when optional notification labels are empty', () => {
    vi.stubGlobal('Notification', FakeNotification);

    expect(deliverBrowserNotification('s', 'e', { ...data, title: '', subtitle: '' })).toBe('delivered');
    expect(FakeNotification.seen).toEqual([
      { title: 'DoomPi', options: { body: 'All checks passed.', tag: 'doompi:s:e' } },
    ]);
  });

  it('returns silent outcomes when delivery is unavailable or not granted', async () => {
    expect(browserNotificationPermission()).toBe('unsupported');
    await expect(requestBrowserNotificationPermission()).resolves.toBe('unsupported');
    expect(deliverBrowserNotification('s', 'e', data)).toBe('unsupported');
    vi.stubGlobal('Notification', FakeNotification);
    FakeNotification.permission = 'default';
    expect(deliverBrowserNotification('s', 'e', data)).toBe('permission-default');
    FakeNotification.permission = 'denied';
    expect(deliverBrowserNotification('s', 'e', data)).toBe('permission-denied');
    expect(FakeNotification.seen).toHaveLength(0);
  });

  it('reports constructor and permission request failures', async () => {
    class ThrowingNotification extends FakeNotification {
      constructor(title: string, options?: NotificationOptions) {
        super(title, options);
        throw new Error('blocked');
      }
    }
    vi.stubGlobal('Notification', ThrowingNotification);
    expect(deliverBrowserNotification('s', 'e', data)).toBe('constructor-error');

    FakeNotification.requestPermission.mockRejectedValue(new Error('blocked'));
    vi.stubGlobal('Notification', FakeNotification);
    expect(browserNotificationPermission()).toBe('granted');
    await expect(requestBrowserNotificationPermission()).resolves.toBe('request-error');
  });
});
