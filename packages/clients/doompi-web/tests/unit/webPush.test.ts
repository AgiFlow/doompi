import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const webPushMocks = vi.hoisted(() => ({
  generateVAPIDKeys: vi.fn(() => ({ publicKey: 'B'.repeat(88), privateKey: 'C'.repeat(44) })),
  sendNotification: vi.fn(async (_subscription: unknown, _payload?: string, _options?: unknown) => undefined),
}));

vi.mock('web-push', () => ({ default: webPushMocks }));

import { createLiveWebPush } from '../../src/adapters/webPush.ts';

const roots: string[] = [];
const subscription = {
  endpoint: 'https://push.example.test/device/one',
  keys: { p256dh: 'D'.repeat(88), auth: 'E'.repeat(22) },
};

function fixture(connected = false) {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'doompi-push-'));
  roots.push(stateDir);
  const notices: string[] = [];
  return {
    notices,
    push: createLiveWebPush({ stateDir, isConnected: () => connected, onNotice: (message) => notices.push(message) }),
    stateDir,
  };
}

beforeEach(() => {
  webPushMocks.generateVAPIDKeys.mockClear();
  webPushMocks.sendNotification.mockReset();
  webPushMocks.sendNotification.mockResolvedValue(undefined);
});

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe('live Web Push', () => {
  it('persists only the VAPID credential, not subscriptions', () => {
    const first = fixture();
    expect(first.push.subscribe('device-1', subscription)).toBe(true);
    const files = fs.readdirSync(first.stateDir);
    expect(files).toEqual(['web-push-vapid.json']);
    expect(fs.statSync(path.join(first.stateDir, files[0] ?? '')).mode & 0o777).toBe(0o600);
  });

  it('refuses malformed or non-HTTPS subscriptions', () => {
    const { push } = fixture();
    expect(push.subscribe('device-1', { ...subscription, endpoint: 'http://push.example.test/device' })).toBe(false);
    expect(push.subscribe('device-1', { ...subscription, endpoint: 'not a URL' })).toBe(false);
    expect(push.subscribe('device-1', { ...subscription, endpoint: `https://push.test/${'x'.repeat(2048)}` })).toBe(
      false,
    );
    expect(push.subscribe('device-1', { endpoint: subscription.endpoint, keys: {} })).toBe(false);
  });

  it('sends a generic zero-TTL payload only while the device has no live socket', async () => {
    const offline = fixture();
    offline.push.subscribe('device-1', subscription);
    await offline.push.notify();
    expect(webPushMocks.sendNotification).toHaveBeenCalledTimes(1);
    const [, payload, options] = webPushMocks.sendNotification.mock.calls[0] ?? [];
    expect(payload).toBe('{"title":"DoomPi","body":"A live session needs your attention.","url":"/"}');
    expect(options).toMatchObject({ TTL: 0, urgency: 'high' });

    webPushMocks.sendNotification.mockClear();
    const connected = fixture(true);
    connected.push.subscribe('device-2', subscription);
    await connected.push.notify();
    expect(webPushMocks.sendNotification).not.toHaveBeenCalled();
  });

  it('drops a provider-expired subscription immediately', async () => {
    const { push } = fixture();
    push.subscribe('device-1', subscription);
    webPushMocks.sendNotification.mockRejectedValueOnce({ statusCode: 410 });
    await push.notify();
    webPushMocks.sendNotification.mockClear();
    await push.notify();
    expect(webPushMocks.sendNotification).not.toHaveBeenCalled();
  });

  it('reports a non-expiry provider failure without dropping the subscription', async () => {
    const { push, notices } = fixture();
    push.subscribe('device-1', subscription);
    webPushMocks.sendNotification.mockRejectedValueOnce({ statusCode: 500 });
    await push.notify();
    expect(notices).toEqual(['live web push delivery failed (500)']);
    webPushMocks.sendNotification.mockClear();
    await push.notify();
    expect(webPushMocks.sendNotification).toHaveBeenCalledOnce();
  });
});
