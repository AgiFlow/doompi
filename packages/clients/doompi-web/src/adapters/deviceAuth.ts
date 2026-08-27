import { createHash, randomBytes } from 'node:crypto';
import {
  type DeviceRecord,
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
        if (verdict.reason !== 'unknown') devices.delete(hash);
        return undefined;
      }
      const seen = touchDevice(verdict.record, at);
      devices.set(hash, seen);
      return seen;
    },

    revoke(id) {
      for (const [hash, record] of devices) {
        if (record.id !== id) continue;
        devices.delete(hash);
        notice(`revoked ${record.label} (${record.id})`);
        return true;
      }
      return false;
    },

    revokeAll() {
      const count = devices.size;
      devices.clear();
      if (count > 0) notice(`revoked ${String(count)} paired device(s)`);
      return count;
    },

    list: () => [...devices.values()],

    sweep() {
      const at = now();
      const settings = options.settings();
      let dropped = 0;
      for (const [hash, record] of devices) {
        if (evaluateDevice(record, at, settings).ok) continue;
        devices.delete(hash);
        dropped += 1;
      }
      return dropped;
    },
  };
}
