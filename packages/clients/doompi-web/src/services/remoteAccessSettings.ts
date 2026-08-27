/**
 * The persisted remote-access settings, and how a bad file becomes a good one.
 *
 * Every failure here is recoverable by falling back, never by throwing: a
 * corrupt settings file must not stop the cockpit from starting, because the
 * cockpit is how you would fix it.
 */

import type { RemoteAccessSettings, SandboxSettings, TunnelConfig } from '../types/remoteAccess.ts';

/** Bumped when a field changes meaning; an unrecognised version falls back to defaults. */
export const REMOTE_SETTINGS_VERSION = 1;

const MIN_MINUTES = 1;
const MAX_MINUTES = 1440;
const MIN_HOURS = 1;
const MAX_HOURS = 720;

/**
 * Both time limits start off.
 *
 * The durations are still here so switching one on lands on a sensible number
 * rather than an empty field. What being off actually means: a tunnel stays up
 * until it is closed or the hub restarts, and a paired session lasts until it
 * is revoked or remote access is switched off. Those two events are the only
 * expiry there is by default.
 */
export const DEFAULT_REMOTE_SETTINGS: RemoteAccessSettings = {
  autoCloseEnabled: false,
  autoCloseMinutes: 60,
  sessionExpiryEnabled: false,
  idleMinutes: 30,
  absoluteHours: 12,
  tunnel: { kind: 'quick' },
  sandbox: { enabled: false, workspaces: [] },
};

export interface ParsedRemoteSettings {
  settings: RemoteAccessSettings;
  /** Everything that had to be corrected, so the host can say so once rather than silently differ. */
  warnings: string[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function readBoolean(raw: unknown, fallback: boolean, field: string, warnings: string[]): boolean {
  if (raw === undefined) return fallback;
  if (typeof raw !== 'boolean') {
    warnings.push(`${field} must be true or false; using ${String(fallback)}.`);
    return fallback;
  }
  return raw;
}

function readClamped(
  raw: unknown,
  fallback: number,
  bounds: { min: number; max: number },
  field: string,
  warnings: string[],
): number {
  if (raw === undefined) return fallback;
  if (typeof raw !== 'number' || !Number.isFinite(raw)) {
    warnings.push(`${field} must be a number; using ${String(fallback)}.`);
    return fallback;
  }
  const clamped = Math.min(bounds.max, Math.max(bounds.min, Math.round(raw)));
  if (clamped !== raw) {
    warnings.push(
      `${field} must be between ${String(bounds.min)} and ${String(bounds.max)}; using ${String(clamped)}.`,
    );
  }
  return clamped;
}

/**
 * A tunnel configuration is only accepted whole.
 *
 * A named tunnel missing its hostname is not a named tunnel with a default, it
 * is a misconfiguration, and quietly falling back to a quick tunnel would swap
 * a stable origin for a rotating one without telling anybody.
 */
function readTunnel(raw: unknown, warnings: string[]): TunnelConfig {
  if (raw === undefined) return DEFAULT_REMOTE_SETTINGS.tunnel;
  if (!isRecord(raw)) {
    warnings.push('tunnel must be an object; using a quick tunnel.');
    return { kind: 'quick' };
  }
  if (raw.kind === 'quick') return { kind: 'quick' };
  if (raw.kind !== 'named') {
    warnings.push(`tunnel.kind must be "quick" or "named"; using a quick tunnel.`);
    return { kind: 'quick' };
  }
  if (typeof raw.hostname !== 'string' || raw.hostname === '') {
    warnings.push('A named tunnel needs a hostname; using a quick tunnel.');
    return { kind: 'quick' };
  }
  return {
    kind: 'named',
    hostname: raw.hostname,
    ...(typeof raw.name === 'string' && raw.name !== '' ? { name: raw.name } : {}),
    ...(typeof raw.tokenFile === 'string' && raw.tokenFile !== '' ? { tokenFile: raw.tokenFile } : {}),
    ...(typeof raw.configFile === 'string' && raw.configFile !== '' ? { configFile: raw.configFile } : {}),
  };
}

/**
 * Reads the container settings, keeping only absolute workspace paths.
 *
 * A relative path would resolve against the container's working directory
 * rather than the host's, which is a mount that silently points somewhere else.
 * Refusing one is better than mounting the wrong directory.
 */
function readSandbox(raw: unknown, warnings: string[]): SandboxSettings {
  const fallback = DEFAULT_REMOTE_SETTINGS.sandbox;
  if (raw === undefined) return fallback;
  if (!isRecord(raw)) {
    warnings.push('sandbox must be an object; the cockpit will not be contained.');
    return fallback;
  }
  const workspaces: string[] = [];
  for (const entry of Array.isArray(raw.workspaces) ? raw.workspaces : []) {
    if (typeof entry !== 'string' || !entry.startsWith('/')) {
      warnings.push(`A workspace must be an absolute path; ignoring ${String(entry)}.`);
      continue;
    }
    if (!workspaces.includes(entry)) workspaces.push(entry);
  }
  return { enabled: readBoolean(raw.enabled, fallback.enabled, 'sandbox.enabled', warnings), workspaces };
}

export function parseRemoteAccessSettings(raw: unknown): ParsedRemoteSettings {
  const warnings: string[] = [];
  if (!isRecord(raw)) {
    return { settings: DEFAULT_REMOTE_SETTINGS, warnings };
  }
  if (raw.version !== REMOTE_SETTINGS_VERSION) {
    warnings.push(
      `Settings version ${String(raw.version)} is not version ${String(REMOTE_SETTINGS_VERSION)}; using defaults.`,
    );
    return { settings: DEFAULT_REMOTE_SETTINGS, warnings };
  }
  const defaults = DEFAULT_REMOTE_SETTINGS;
  return {
    settings: {
      autoCloseEnabled: readBoolean(raw.autoCloseEnabled, defaults.autoCloseEnabled, 'autoCloseEnabled', warnings),
      autoCloseMinutes: readClamped(
        raw.autoCloseMinutes,
        defaults.autoCloseMinutes,
        { min: MIN_MINUTES, max: MAX_MINUTES },
        'autoCloseMinutes',
        warnings,
      ),
      sessionExpiryEnabled: readBoolean(
        raw.sessionExpiryEnabled,
        defaults.sessionExpiryEnabled,
        'sessionExpiryEnabled',
        warnings,
      ),
      idleMinutes: readClamped(
        raw.idleMinutes,
        defaults.idleMinutes,
        { min: MIN_MINUTES, max: MAX_MINUTES },
        'idleMinutes',
        warnings,
      ),
      absoluteHours: readClamped(
        raw.absoluteHours,
        defaults.absoluteHours,
        { min: MIN_HOURS, max: MAX_HOURS },
        'absoluteHours',
        warnings,
      ),
      tunnel: readTunnel(raw.tunnel, warnings),
      sandbox: readSandbox(raw.sandbox, warnings),
    },
    warnings,
  };
}

export function serializeRemoteAccessSettings(settings: RemoteAccessSettings): unknown {
  return { version: REMOTE_SETTINGS_VERSION, ...settings };
}
