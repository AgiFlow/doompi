import fs from 'node:fs';
import path from 'node:path';
import { validateTargetName } from '../services/devProxyPolicy.ts';
import type { DevProxyTarget } from '../types/devProxy.ts';

/**
 * Registered proxy targets on disk.
 *
 * Persisted, unlike a remote session, because a target is a name the developer
 * typed into their own build configuration as `base: '/devproxy/<name>/'`.
 * Losing it on restart would silently break that line, and the file holds no
 * secret: a port number and a label the operator chose while sitting at the
 * machine.
 */

const TARGETS_FILE = 'dev-proxy.json';
const DIRECTORY_MODE = 0o700;
const FILE_MODE = 0o600;
/** Any bit set for group or other; a state file readable by another account is worth repairing. */
const LOOSE_MODE_MASK = 0o077;

export interface DevProxyStoreOptions {
  /** The same directory the remote-access store uses; defaults to ~/.doompi/web. */
  stateDir: string;
  onNotice?: (message: string) => void;
}

export interface DevProxyStore {
  targets(): readonly DevProxyTarget[];
  find(name: string): DevProxyTarget | undefined;
  /** Replaces any target already holding this name, so re-registering a moved port is one call. */
  save(target: DevProxyTarget): void;
  remove(name: string): boolean;
}

/** Repairs a state file another account can read. */
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
 * Rebuilds one record, dropping anything the current policy would refuse.
 *
 * The file is revalidated on read rather than trusted, because a name that was
 * legal when written is not necessarily legal now, and an edited file must not
 * be able to introduce a target the API would have rejected.
 */
function parseTarget(value: unknown): DevProxyTarget | undefined {
  if (typeof value !== 'object' || value === null) return undefined;
  const record = value as Partial<DevProxyTarget>;
  const name = validateTargetName(record.name);
  if (!name.ok) return undefined;
  if (typeof record.port !== 'number' || !Number.isSafeInteger(record.port)) return undefined;
  const createdAt = typeof record.createdAt === 'number' ? record.createdAt : 0;
  return { name: name.name, port: record.port, createdAt };
}

export function createDevProxyStore(options: DevProxyStoreOptions): DevProxyStore {
  const notice = options.onNotice ?? ((): void => {});
  const targetsPath = path.join(options.stateDir, TARGETS_FILE);
  let held = load();

  function load(): DevProxyTarget[] {
    let raw: string;
    try {
      raw = fs.readFileSync(targetsPath, 'utf8');
    } catch {
      // No file is the normal first run, so this is not worth a notice.
      return [];
    }
    tightenMode(targetsPath, notice);
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      notice(`dev proxy targets at ${targetsPath} are not valid JSON; none will load`);
      return [];
    }
    if (!Array.isArray(parsed)) return [];
    return parsed.map(parseTarget).filter((target): target is DevProxyTarget => target !== undefined);
  }

  function write(): void {
    const temporary = `${targetsPath}.${String(process.pid)}.tmp`;
    try {
      fs.mkdirSync(options.stateDir, { recursive: true, mode: DIRECTORY_MODE });
      fs.writeFileSync(temporary, `${JSON.stringify(held, undefined, 2)}\n`, { mode: FILE_MODE });
      // Rename rather than write in place, so a crash mid-write leaves the
      // previous contents rather than a truncated file.
      fs.renameSync(temporary, targetsPath);
    } catch (error) {
      notice(`${targetsPath} could not be saved: ${error instanceof Error ? error.message : String(error)}`);
      try {
        fs.rmSync(temporary, { force: true });
      } catch {
        // Nothing further to do; the temp file is inert either way.
      }
    }
  }

  return {
    targets: () => held,
    find: (name) => held.find((target) => target.name === name),

    save(target) {
      held = [...held.filter((existing) => existing.name !== target.name), target];
      write();
    },

    remove(name) {
      const next = held.filter((existing) => existing.name !== name);
      if (next.length === held.length) return false;
      held = next;
      write();
      return true;
    },
  };
}
