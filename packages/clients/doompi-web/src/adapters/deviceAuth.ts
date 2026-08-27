import { createHash, randomBytes } from 'node:crypto';
import {
  type DeviceRecord,
  deviceExpiryAt,
  deviceLabelFor,
  evaluateDevice,
  sanitizeUserAgent,
  touchDevice,
} from '../services/deviceSessions.ts';
import type { RemoteAccessSettings } from '../types/remoteAccess.ts';

/** 256 bits. The token is scanned or set by the server, never typed, so there is no reason to economise. */
const TOKEN_BYTES = 32;
const ID_BYTES = 8;

export interface DeviceAuthOptions {
  /** Read fresh on every check, so a changed toggle takes effect on the next request. */
  settings: () => RemoteAccessSettings;
  now?: () => number;
  onNotice?: (message: string) => void;
  onDrop?: (record: DeviceRecord, reason: 'revoked' | 'expired') => void;
}

export interface EnrolledDevice {
  /** Returned exactly once, to be sent as the cookie value. Only its digest is retained. */
  token: string;
  record: DeviceRecord;
}

export interface DeviceAuth {
  enrol(input: { userAgent: string | undefined }): EnrolledDevice;
  /** The device this cookie names, or undefined. Bumps last-seen as a side effect. */
  verify(token: string | undefined): DeviceRecord | undefined;
  revoke(id: string): boolean;
  revokeAll(): number;
  list(): readonly DeviceRecord[];
  /** Re-arms exact deadlines after expiry settings change. */
  reschedule(): void;
  /** Drops what has expired under the current settings. Returns how many went. */
  sweep(): number;
}

function digest(token: string): string {
  // No salt and no KDF, deliberately. The input is 256 bits of uniform
  // randomness, so there is no dictionary to attack and a slow hash would only
  // add latency to every request. Do not "fix" this into bcrypt.
  return createHash('sha256').update(token).digest('hex');
}

/**
 * Paired sessions, held in memory only.
 *
 * Keyed by digest rather than scanned, so verification is a map lookup and
 * there is no comparison loop for a timing side channel to live in. That is why
 * `timingSafeEqual` does not appear here: there is nothing to compare. If a
 * future change introduces a scan, it will need one.
 */
export function createDeviceAuth(options: DeviceAuthOptions): DeviceAuth {
  const now = options.now ?? ((): number => Date.now());
  const notice = options.onNotice ?? ((): void => {});
  /** Digest to record. The raw token exists only in flight. */
  const devices = new Map<string, DeviceRecord>();
  const timers = new Map<string, ReturnType<typeof setTimeout>>();

  const clearDeadline = (hash: string): void => {
    const timer = timers.get(hash);
    if (timer !== undefined) clearTimeout(timer);
    timers.delete(hash);
  };

  const drop = (hash: string, reason: 'revoked' | 'expired'): DeviceRecord | undefined => {
    const record = devices.get(hash);
    if (record === undefined) return undefined;
    devices.delete(hash);
    clearDeadline(hash);
    options.onDrop?.(record, reason);
    return record;
  };

  const schedule = (hash: string, record: DeviceRecord): void => {
    clearDeadline(hash);
    const deadline = deviceExpiryAt(record, options.settings());
    if (deadline === undefined) return;
    const remaining = deadline - now();
    if (remaining <= 0) {
      drop(hash, 'expired');
      return;
    }
    const timer = setTimeout(
      () => {
        const current = devices.get(hash);
        if (current === undefined) return;
        if (evaluateDevice(current, now(), options.settings()).ok) schedule(hash, current);
        else drop(hash, 'expired');
      },
      Math.min(remaining, 2_147_483_647),
    );
    timer.unref();
    timers.set(hash, timer);
  };
  return {
    enrol(input) {
      const token = randomBytes(TOKEN_BYTES).toString('base64url');
      const userAgent = sanitizeUserAgent(input.userAgent);
      const at = now();
      const record: DeviceRecord = {
        id: randomBytes(ID_BYTES).toString('hex'),
        tokenHash: digest(token),
        label: deviceLabelFor(userAgent),
        userAgent,
        createdAt: at,
        lastSeenAt: at,
      };
      devices.set(record.tokenHash, record);
      schedule(record.tokenHash, record);
      notice(`paired ${record.label} (${record.id})`);
      return { token, record };
    },

    verify(token) {
      if (token === undefined || token === '') return undefined;
      const hash = digest(token);
      const at = now();
      const verdict = evaluateDevice(devices.get(hash), at, options.settings());
      if (!verdict.ok) {
        // An expired record is dropped on the way past rather than left to the
        // sweeper, so a revoked-by-time device stops appearing in the list.
        if (verdict.reason !== 'unknown') drop(hash, 'expired');
        return undefined;
      }
      const seen = touchDevice(verdict.record, at);
      devices.set(hash, seen);
      schedule(hash, seen);
      return seen;
    },

    revoke(id) {
      for (const [hash, record] of devices) {
        if (record.id !== id) continue;
        drop(hash, 'revoked');
        notice(`revoked ${record.label} (${record.id})`);
        return true;
      }
      return false;
    },

    revokeAll() {
      const records = [...devices.values()];
      for (const [hash] of devices) drop(hash, 'revoked');
      if (records.length > 0) notice(`revoked ${String(records.length)} paired device(s)`);
      return records.length;
    },

    list: () => [...devices.values()],

    reschedule() {
      for (const [hash, record] of devices) schedule(hash, record);
    },
    sweep() {
      const at = now();
      const settings = options.settings();
      let dropped = 0;
      for (const [hash, record] of devices) {
        if (evaluateDevice(record, at, settings).ok) continue;
        drop(hash, 'expired');
        dropped += 1;
      }
      return dropped;
    },
  };
}
