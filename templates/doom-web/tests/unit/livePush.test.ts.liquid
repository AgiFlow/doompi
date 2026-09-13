import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { sealedHttpSession } from '../../src/web/lib/sealedSession.ts';
import {
  disableLivePush,
  enableLivePush,
  livePushStatus,
  restoreLivePushRegistration,
} from '../../src/web/lib/livePush.ts';

const APPLICATION_KEY = 'B'.repeat(88);

class FakeNotification {
  static permission: NotificationPermission = 'default';
  static requestPermission = vi.fn(async (): Promise<NotificationPermission> => FakeNotification.permission);
}

class FakeServiceWorkerRegistration {
  showNotification(): Promise<void> {
    return Promise.resolve();
  }
}

function subscription(key: ArrayBuffer | null = null) {
  return {
    options: { applicationServerKey: key },
    toJSON: () => ({ endpoint: 'https://push.example/device', keys: { p256dh: 'D'.repeat(88), auth: 'E'.repeat(22) } }),
    unsubscribe: vi.fn(async () => true),
  } as unknown as PushSubscription;
}

function browser(existing: PushSubscription | null = null) {
  let current = existing;
  const manager = {
    getSubscription: vi.fn(async () => current),
    subscribe: vi.fn(async () => {
      current = subscription();
      return current;
    }),
  };
  const registration = { pushManager: manager } as unknown as ServiceWorkerRegistration;
  vi.stubGlobal('window', { PushManager: class {} });
  vi.stubGlobal('PushManager', class {});
  vi.stubGlobal('ServiceWorkerRegistration', FakeServiceWorkerRegistration);
  vi.stubGlobal('Notification', FakeNotification);
  vi.stubGlobal('navigator', { serviceWorker: { ready: Promise.resolve(registration) } });
  return { manager, registration };
}

function responses(...items: Response[]): ReturnType<typeof vi.spyOn> {
  return vi
    .spyOn(sealedHttpSession, 'fetch')
    .mockImplementation(async () => items.shift() ?? new Response(null, { status: 204 }));
}

function keyResponse(): Response {
  return new Response(JSON.stringify({ publicKey: APPLICATION_KEY }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

beforeEach(() => {
  FakeNotification.permission = 'default';
  FakeNotification.requestPermission.mockClear();
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('browser live Push registration', () => {
  it('reports unsupported without the required browser APIs', async () => {
    vi.stubGlobal('window', {});
    vi.stubGlobal('navigator', {});
    expect(await livePushStatus()).toBe('unsupported');
    expect(await enableLivePush()).toBe('unsupported');
    expect(await disableLivePush()).toBe('unsupported');
    await restoreLivePushRegistration();
  });

  it('reports permission and subscription state without prompting', async () => {
    browser();
    expect(await livePushStatus()).toBe('disabled');
    await restoreLivePushRegistration();
    FakeNotification.permission = 'denied';
    expect(await livePushStatus()).toBe('denied');
    FakeNotification.permission = 'granted';
    expect(await livePushStatus()).toBe('disabled');

    browser(subscription());
    FakeNotification.permission = 'granted';
    expect(await livePushStatus()).toBe('enabled');
  });

  it('subscribes and registers with the sealed device route after a user grant', async () => {
    const { manager } = browser();
    FakeNotification.permission = 'granted';
    const fetch = responses(keyResponse(), new Response(null, { status: 204 }));
    expect(await enableLivePush()).toBe('enabled');
    expect(manager.subscribe).toHaveBeenCalledWith({
      userVisibleOnly: true,
      applicationServerKey: expect.any(Uint8Array),
    });
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(fetch.mock.calls[1]?.[1]).toMatchObject({ method: 'POST' });
  });

  it('reuses a subscription with the same VAPID key after a fresh permission grant', async () => {
    const decoded = Uint8Array.from(atob(APPLICATION_KEY), (character) => character.charCodeAt(0));
    const existing = subscription(decoded.buffer);
    const { manager } = browser(existing);
    FakeNotification.permission = 'default';
    FakeNotification.requestPermission.mockResolvedValueOnce('granted');
    responses(keyResponse(), new Response(null, { status: 204 }));
    expect(await enableLivePush()).toBe('enabled');
    expect(manager.subscribe).not.toHaveBeenCalled();
    expect(existing.unsubscribe).not.toHaveBeenCalled();
  });

  it('does not subscribe when permission is refused or the VAPID response is malformed', async () => {
    browser();
    FakeNotification.permission = 'denied';
    expect(await enableLivePush()).toBe('denied');

    FakeNotification.permission = 'default';
    expect(await enableLivePush()).toBe('disabled');

    FakeNotification.permission = 'granted';
    const malformed = responses(new Response('{}', { status: 200 }));
    expect(await enableLivePush()).toBe('error');
    malformed.mockRestore();
    const failed = responses(new Response('{}', { status: 500 }));
    expect(await enableLivePush()).toBe('error');
    failed.mockRestore();
    const empty = responses(new Response('null', { status: 200 }));
    expect(await enableLivePush()).toBe('error');
    empty.mockRestore();
    responses(new Response('{"publicKey":"%"}', { status: 200 }));
    expect(await enableLivePush()).toBe('error');
  });

  it('replaces a subscription made under a rotated VAPID key', async () => {
    const old = subscription(new Uint8Array([1, 2, 3]).buffer);
    const { manager } = browser(old);
    FakeNotification.permission = 'granted';
    responses(keyResponse(), new Response(null, { status: 204 }));
    expect(await enableLivePush()).toBe('enabled');
    expect(old.unsubscribe).toHaveBeenCalledOnce();
    expect(manager.subscribe).toHaveBeenCalledOnce();
  });

  it('replaces a same-length but different VAPID key', async () => {
    const decoded = Uint8Array.from(atob(APPLICATION_KEY), (character) => character.charCodeAt(0));
    const old = subscription(new Uint8Array(decoded.length).buffer);
    const { manager } = browser(old);
    FakeNotification.permission = 'granted';
    responses(keyResponse(), new Response(null, { status: 204 }));
    expect(await enableLivePush()).toBe('enabled');
    expect(old.unsubscribe).toHaveBeenCalledOnce();
    expect(manager.subscribe).toHaveBeenCalledOnce();
  });

  it('unsubscribes when host registration fails and when the user disables Push', async () => {
    const created = subscription();
    const { manager } = browser();
    manager.subscribe.mockResolvedValue(created);
    FakeNotification.permission = 'granted';
    responses(keyResponse(), new Response('{}', { status: 500 }));
    expect(await enableLivePush()).toBe('error');
    expect(created.unsubscribe).toHaveBeenCalledOnce();

    const held = subscription();
    browser(held);
    responses(new Response(null, { status: 204 }));
    expect(await disableLivePush()).toBe('disabled');
    expect(held.unsubscribe).toHaveBeenCalledOnce();

    browser();
    responses(new Response('{}', { status: 500 }));
    expect(await disableLivePush()).toBe('error');
  });

  it('re-registers a browser-held subscription after host restart without prompting', async () => {
    browser(subscription());
    FakeNotification.permission = 'granted';
    const fetch = responses(keyResponse(), new Response(null, { status: 204 }));
    await restoreLivePushRegistration();
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(FakeNotification.requestPermission).not.toHaveBeenCalled();
  });

  it('reports browser failures and leaves opportunistic restoration silent', async () => {
    browser();
    FakeNotification.permission = 'granted';
    vi.stubGlobal('navigator', { serviceWorker: { ready: Promise.reject(new Error('gone')) } });
    expect(await livePushStatus()).toBe('error');
    expect(await enableLivePush()).toBe('error');
    expect(await disableLivePush()).toBe('error');
    await restoreLivePushRegistration();

    const { manager } = browser();
    FakeNotification.permission = 'granted';
    await restoreLivePushRegistration();
    expect(manager.getSubscription).toHaveBeenCalledOnce();

    browser(subscription());
    const fetch = responses(new Response('{}', { status: 200 }));
    await restoreLivePushRegistration();
    expect(fetch).toHaveBeenCalledOnce();
  });
});
