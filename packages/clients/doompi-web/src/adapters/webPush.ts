import fs from 'node:fs';
import path from 'node:path';
import webPush, { type PushSubscription } from 'web-push';

const VAPID_FILE = 'web-push-vapid.json';
const MAX_ENDPOINT_LENGTH = 2048;
const PUSH_PAYLOAD = JSON.stringify({
  title: 'DoomPi',
  body: 'A live session needs your attention.',
  url: '/',
});

interface VapidKeys {
  publicKey: string;
  privateKey: string;
}

export interface LiveWebPush {
  publicKey(): string;
  subscribe(deviceId: string, value: unknown): boolean;
  remove(deviceId: string): void;
  notify(): Promise<void>;
  close(): void;
}

export interface LiveWebPushOptions {
  stateDir: string;
  isConnected: (deviceId: string) => boolean;
  onNotice?: (message: string) => void;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function validKey(value: unknown, minimum: number): value is string {
  return typeof value === 'string' && value.length >= minimum && value.length <= 256 && /^[A-Za-z0-9_-]+$/u.test(value);
}

function parseSubscription(value: unknown): PushSubscription | undefined {
  if (!isRecord(value) || typeof value.endpoint !== 'string' || value.endpoint.length > MAX_ENDPOINT_LENGTH)
    return undefined;
  let endpoint: URL;
  try {
    endpoint = new URL(value.endpoint);
  } catch {
    return undefined;
  }
  if (endpoint.protocol !== 'https:' || !isRecord(value.keys)) return undefined;
  if (!validKey(value.keys.p256dh, 40) || !validKey(value.keys.auth, 8)) return undefined;
  return {
    endpoint: endpoint.href,
    keys: { p256dh: value.keys.p256dh, auth: value.keys.auth },
  };
}

function parseVapidKeys(value: unknown): VapidKeys | undefined {
  if (!isRecord(value) || !validKey(value.publicKey, 40) || !validKey(value.privateKey, 20)) return undefined;
  return { publicKey: value.publicKey, privateKey: value.privateKey };
}

function loadVapidKeys(stateDir: string, notice: (message: string) => void): VapidKeys {
  const file = path.join(stateDir, VAPID_FILE);
  try {
    const parsed = parseVapidKeys(JSON.parse(fs.readFileSync(file, 'utf8')));
    if (parsed !== undefined) return parsed;
    notice('web push VAPID state was invalid; rotating it and dropping live subscriptions');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT')
      notice(`web push VAPID state was unreadable; rotating it (${String(error)})`);
  }

  const generated = webPush.generateVAPIDKeys();
  const keys = { publicKey: generated.publicKey, privateKey: generated.privateKey };
  fs.mkdirSync(stateDir, { recursive: true, mode: 0o700 });
  const temporary = `${file}.${String(process.pid)}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify(keys)}\n`, { encoding: 'utf8', mode: 0o600 });
  fs.renameSync(temporary, file);
  fs.chmodSync(file, 0o600);
  return keys;
}

/** Keeps only in-memory subscriptions and sends generic, zero-TTL live notices. */
export function createLiveWebPush(options: LiveWebPushOptions): LiveWebPush {
  const notice = options.onNotice ?? ((): void => {});
  const keys = loadVapidKeys(options.stateDir, notice);
  const subscriptions = new Map<string, PushSubscription>();
  const vapidDetails = {
    subject: 'mailto:notifications@doompi.local',
    publicKey: keys.publicKey,
    privateKey: keys.privateKey,
  };

  return {
    publicKey: () => keys.publicKey,
    subscribe(deviceId, value) {
      const subscription = parseSubscription(value);
      if (subscription === undefined) return false;
      subscriptions.set(deviceId, subscription);
      return true;
    },
    remove(deviceId) {
      subscriptions.delete(deviceId);
    },
    async notify() {
      await Promise.all(
        [...subscriptions.entries()].map(async ([deviceId, subscription]) => {
          if (options.isConnected(deviceId)) return;
          try {
            await webPush.sendNotification(subscription, PUSH_PAYLOAD, {
              TTL: 0,
              urgency: 'high',
              vapidDetails,
            });
          } catch (error) {
            const statusCode = isRecord(error) && typeof error.statusCode === 'number' ? error.statusCode : undefined;
            if (statusCode === 404 || statusCode === 410) subscriptions.delete(deviceId);
            else notice(`live web push delivery failed${statusCode === undefined ? '' : ` (${String(statusCode)})`}`);
          }
        }),
      );
    },
    close() {
      subscriptions.clear();
    },
  };
}
