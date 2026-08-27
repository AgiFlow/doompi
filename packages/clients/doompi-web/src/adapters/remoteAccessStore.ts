import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  DEFAULT_REMOTE_SETTINGS,
  parseRemoteAccessSettings,
  serializeRemoteAccessSettings,
} from '../services/remoteAccessSettings.ts';
import type { StoredCredential } from '../services/webauthnPolicy.ts';
import type { RemoteAccessSettings } from '../types/remoteAccess.ts';

/** Where the cockpit keeps machine-local state; `doompi sync` already writes its bundle here. */
const STATE_SEGMENTS = ['.doompi', 'web'];
const SETTINGS_FILE = 'remote-access.json';
const CREDENTIALS_FILE = 'credentials.json';
const DIRECTORY_MODE = 0o700;
const FILE_MODE = 0o600;
/** Any bit set for group or other; a state file readable by another account is worth repairing. */
const LOOSE_MODE_MASK = 0o077;

export interface RemoteAccessStoreOptions {
  /** Overridden by --state-dir and by tests; the default is ~/.doompi/web. */
  stateDir?: string;
  onNotice?: (message: string) => void;
}

export interface RemoteAccessStore {
  readonly directory: string;
  settings(): RemoteAccessSettings;
  save(settings: RemoteAccessSettings): void;
  /**
   * Registered passkeys. Public keys only, so the file is not a bearer secret
   * and losing it costs a re-enrolment rather than an account.
   */
  credentials(): readonly StoredCredential[];
  saveCredential(credential: StoredCredential): void;
  removeCredential(id: string): boolean;
}

export function defaultRemoteStateDir(homeDir: string = os.homedir()): string {
  return path.join(homeDir, ...STATE_SEGMENTS);
}

/**
 * Repairs a state file another account can read.
 *
 * Cheap, and it catches the cases a fresh write never would: a file restored
 * from a backup, copied with a permissive umask, or checked out of somewhere it
 * should not have been.
 */
function tightenMode(filePath: string, notice: (message: string) => void): void {
  try {
    if ((fs.statSync(filePath).mode & LOOSE_MODE_MASK) === 0) return;
    fs.chmodSync(filePath, FILE_MODE);
    notice(`tightened permissions on ${filePath}`);
  } catch {
    // The file is missing or unreadable; the caller's own read reports that.
  }
}

/**
 * Settings and passkeys on disk. Sessions deliberately not.
 *
 * A session is revoked when remote access is switched off, and a hub restart is
 * a switch-off, so persisting one would buy nothing while creating a bearer
 * secret worth stealing. A passkey is the opposite: surviving is its whole
 * point, and what is stored is a public key.
 */
export function createRemoteAccessStore(options: RemoteAccessStoreOptions = {}): RemoteAccessStore {
  const directory = options.stateDir ?? defaultRemoteStateDir();
  const notice = options.onNotice ?? ((): void => {});
  const settingsPath = path.join(directory, SETTINGS_FILE);
  const credentialsPath = path.join(directory, CREDENTIALS_FILE);

  let current = load();
  let registered = loadCredentials();

  function load(): RemoteAccessSettings {
    let raw: string;
    try {
      raw = fs.readFileSync(settingsPath, 'utf8');
    } catch {
      // No file is the normal first run, so this is not worth a notice.
      return DEFAULT_REMOTE_SETTINGS;
    }
    tightenMode(settingsPath, notice);
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      // Left in place rather than rewritten: silently overwriting a file
      // somebody hand-edited is worse than ignoring it for this run.
      notice(`remote access settings at ${settingsPath} are not valid JSON; using defaults`);
      return DEFAULT_REMOTE_SETTINGS;
    }
    const outcome = parseRemoteAccessSettings(parsed);
    for (const warning of outcome.warnings) notice(`remote access settings: ${warning}`);
    return outcome.settings;
  }

  function loadCredentials(): StoredCredential[] {
    let raw: string;
    try {
      raw = fs.readFileSync(credentialsPath, 'utf8');
    } catch {
      return [];
    }
    tightenMode(credentialsPath, notice);
    try {
      const parsed: unknown = JSON.parse(raw);
      return Array.isArray(parsed) ? (parsed as StoredCredential[]) : [];
    } catch {
      // Fails closed: a half-readable credential file means enrolling again,
      // not guessing which entries survived.
      notice(`registered passkeys at ${credentialsPath} are not valid JSON; none will load`);
      return [];
    }
  }

  function writeJson(target: string, body: unknown): void {
    const temporary = `${target}.${String(process.pid)}.tmp`;
    try {
      fs.mkdirSync(directory, { recursive: true, mode: DIRECTORY_MODE });
      fs.writeFileSync(temporary, `${JSON.stringify(body, undefined, 2)}\n`, { mode: FILE_MODE });
      // Rename rather than write in place, so a crash mid-write leaves the
      // previous contents rather than a truncated file.
      fs.renameSync(temporary, target);
    } catch (error) {
      notice(`${target} could not be saved: ${error instanceof Error ? error.message : String(error)}`);
      try {
        fs.rmSync(temporary, { force: true });
      } catch {
        // Nothing further to do; the temp file is inert either way.
      }
    }
  }

  return {
    directory,
    settings: () => current,
    credentials: () => registered,

    saveCredential(credential) {
      registered = [...registered.filter((held) => held.id !== credential.id), credential];
      writeJson(credentialsPath, registered);
    },

    removeCredential(id) {
      const next = registered.filter((held) => held.id !== id);
      if (next.length === registered.length) return false;
      registered = next;
      writeJson(credentialsPath, registered);
      return true;
    },

    save(settings) {
      current = settings;
      writeJson(settingsPath, serializeRemoteAccessSettings(settings));
    },
  };
}
