import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import type { GitAuthView } from '../../types/gitAuth';
import { readJson, writeJsonAtomic } from '../atomicJson';
import { invalidRequest } from '../errors';
import { credentialsFile, doomGitRoot } from '../paths';
import type { GitAuthConfig, GitAuthFile, GitAuthStore, RemoteEnv } from './type';

/**
 * Per-workspace remote auth for doompi-git's own fetch, pull, push and rebase.
 *
 * DESIGN PATTERNS:
 * - One file outside every repository, folder 0700 and file 0600, repaired on
 *   read if something loosened it. The token never leaves this module except
 *   into the environment of one git child process.
 * - Config reaches git through GIT_CONFIG_COUNT environment entries, never
 *   argv, so nothing secret shows in `ps`. The first entry empties the
 *   credential helper list, which is what keeps macOS's osxkeychain helper from
 *   storing the token after a successful push.
 * - The token is offered only to the host it was entered for. A repository
 *   whose remote points anywhere else gets this machine's own credentials.
 *
 * AVOID:
 * - Touching process.env. The hub runs every session; anything set there
 *   would reach the agent's shell, which the user ruled out.
 */

const OWNER_ONLY_DIRECTORY = 0o700;
const OWNER_ONLY_FILE = 0o600;
const LOOSE_BITS = 0o077;
const HOST_PATTERN = /^[a-z0-9.-]{1,253}(:\d{1,5})?$/u;
const MAX_USERNAME = 256;
const MAX_TOKEN = 4096;
const SETTINGS_HINT = 'Open settings, then repository, then git remote.';

/** Environment that would make git log or skip what this module relies on. */
const STRIPPED_ALWAYS = ['GIT_CURL_VERBOSE', 'GIT_TRACE_REDACT'];
const STRIPPED_PREFIXES = ['GIT_TRACE'];
/** Environment that could redirect or override credentials when the workspace's own are in play. */
const STRIPPED_CREDENTIALED = [
  'GIT_CONFIG_PARAMETERS',
  'GIT_CONFIG_COUNT',
  'GIT_SSL_NO_VERIFY',
  'SSH_ASKPASS',
  'GIT_SSH',
  'GIT_SSH_COMMAND',
];
const CONFIG_ENTRY = /^GIT_CONFIG_(KEY|VALUE)_\d+$/u;

/** The inline helper: answers `get` from this child's environment, and ignores `store` and `erase`. */
const ENV_CREDENTIAL_HELPER =
  '!f(){ test "$1" = get && printf "username=%s\\npassword=%s\\n" "$DOOMPI_GIT_USERNAME" "$DOOMPI_GIT_TOKEN"; }; f';

/** Whether a value holds an ASCII control character; a newline in a credential field could add a line to git's credential protocol. */
function hasControl(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code < 0x20 || code === 0x7f) return true;
  }
  return false;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** The workspace key: the canonical root, so a symlinked path and its target share one entry. */
function workspaceKey(workspaceRoot: string): string {
  try {
    return fs.realpathSync(workspaceRoot);
  } catch {
    return path.resolve(workspaceRoot);
  }
}

function expandHome(keyPath: string, homeDir: string): string {
  return keyPath.startsWith('~/') ? path.join(homeDir, keyPath.slice(2)) : keyPath;
}

function parseConfig(value: unknown): GitAuthConfig | undefined {
  if (!isRecord(value)) return undefined;
  if (value.method === 'none') return { method: 'none' };
  if (value.method === 'ssh') {
    if (value.keyPath === undefined) return { method: 'ssh' };
    return typeof value.keyPath === 'string' && value.keyPath !== ''
      ? { method: 'ssh', keyPath: value.keyPath }
      : undefined;
  }
  if (
    value.method === 'https' &&
    typeof value.host === 'string' &&
    typeof value.username === 'string' &&
    typeof value.token === 'string' &&
    value.token !== ''
  ) {
    return { method: 'https', host: value.host, username: value.username, token: value.token };
  }
  return undefined;
}

/** What the browser may see. The token becomes a yes or no. */
export function publicView(config: GitAuthConfig): GitAuthView {
  if (config.method === 'ssh')
    return config.keyPath === undefined
      ? { method: 'ssh', ssh: {} }
      : { method: 'ssh', ssh: { keyPath: config.keyPath } };
  if (config.method === 'https') {
    return { method: 'https', https: { host: config.host, username: config.username, hasToken: config.token !== '' } };
  }
  return { method: 'none' };
}

/**
 * A browser save request, checked field by field. An absent HTTPS token keeps
 * the saved one, and only for the same host: a token never follows a host it
 * was not entered for.
 */
export function parseGitAuthSave(request: unknown, current: GitAuthConfig, homeDir: string): GitAuthConfig {
  if (!isRecord(request))
    throw invalidRequest('The git auth request is not an object.', 'Send method none, ssh or https.');
  if (request.method === 'none') return { method: 'none' };
  if (request.method === 'ssh') {
    if (request.keyPath === undefined || request.keyPath === '') return { method: 'ssh' };
    if (typeof request.keyPath !== 'string' || hasControl(request.keyPath)) {
      throw invalidRequest('The key path is not a plain path.', 'Give the key as an absolute path or one under ~/.');
    }
    const keyPath = request.keyPath.trim();
    if (!keyPath.startsWith('/') && !keyPath.startsWith('~/')) {
      throw invalidRequest('The key path is not absolute.', 'Give the key as an absolute path or one under ~/.');
    }
    let isFile = false;
    try {
      isFile = fs.statSync(expandHome(keyPath, homeDir)).isFile();
    } catch {
      isFile = false;
    }
    if (!isFile)
      throw invalidRequest(`No key file at ${keyPath}.`, 'Check the path, or leave it blank to use ssh-agent.');
    return { method: 'ssh', keyPath };
  }
  if (request.method === 'https') {
    const host = typeof request.host === 'string' ? request.host.trim().toLowerCase() : '';
    if (!HOST_PATTERN.test(host))
      throw invalidRequest('The host is not a host name.', 'Use a host like github.com, with an optional :port.');
    const username = typeof request.username === 'string' ? request.username.trim() : '';
    if (username === '' || username.length > MAX_USERNAME || hasControl(username)) {
      throw invalidRequest('The username is empty or not plain text.', 'Enter the username the host knows you by.');
    }
    if (request.token !== undefined && request.token !== '') {
      if (typeof request.token !== 'string' || request.token.length > MAX_TOKEN || hasControl(request.token)) {
        throw invalidRequest('The token is not plain text.', 'Paste the token again without line breaks.');
      }
      return { method: 'https', host, username, token: request.token };
    }
    if (current.method === 'https' && current.host === host && current.token !== '') {
      return { method: 'https', host, username, token: current.token };
    }
    throw invalidRequest(
      current.method === 'https' ? 'The host changed, so the saved token cannot follow it.' : 'A token is required.',
      'Enter the personal access token for this host.',
    );
  }
  throw invalidRequest('The git auth method is unknown.', 'Send method none, ssh or https.');
}

/** Tightens a file or folder something left readable by group or others. */
function tighten(target: string, mode: number): void {
  try {
    if ((fs.statSync(target).mode & LOOSE_BITS) !== 0) fs.chmodSync(target, mode);
  } catch {
    // Absent is fine: the first save creates it with the right mode.
  }
}

export function createGitAuthStore(homeDir: string = os.homedir()): GitAuthStore {
  const file = credentialsFile(homeDir);
  const readFile = (): GitAuthFile => {
    tighten(file, OWNER_ONLY_FILE);
    const raw = readJson<unknown>(file);
    const workspaces: Record<string, GitAuthConfig> = {};
    if (isRecord(raw) && raw.version === 1 && isRecord(raw.workspaces)) {
      for (const [key, value] of Object.entries(raw.workspaces)) {
        // A malformed entry is treated as unset rather than guessed at.
        const config = parseConfig(value);
        if (config !== undefined) workspaces[key] = config;
      }
    }
    return { version: 1, workspaces };
  };
  const read = (workspaceRoot: string): GitAuthConfig =>
    readFile().workspaces[workspaceKey(workspaceRoot)] ?? { method: 'none' };

  return {
    read,
    view: (workspaceRoot) => publicView(read(workspaceRoot)),
    save(workspaceRoot, request) {
      const key = workspaceKey(workspaceRoot);
      const current = readFile();
      const next = parseGitAuthSave(request, current.workspaces[key] ?? { method: 'none' }, homeDir);
      const root = doomGitRoot(homeDir);
      fs.mkdirSync(root, { recursive: true, mode: OWNER_ONLY_DIRECTORY });
      fs.chmodSync(root, OWNER_ONLY_DIRECTORY);
      const workspaces = { ...current.workspaces };
      if (next.method === 'none') delete workspaces[key];
      else workspaces[key] = next;
      writeJsonAtomic(file, { version: 1, workspaces } satisfies GitAuthFile);
      fs.chmodSync(file, OWNER_ONLY_FILE);
      return publicView(next);
    },
  };
}

/** The transport and host a remote URL names, or undefined for a local path or anything else. */
export function remoteTransport(url: string): { kind: 'https' | 'http' | 'ssh'; host: string } | undefined {
  const trimmed = url.trim();
  if (/^[a-z][a-z0-9+.-]*:\/\//iu.test(trimmed)) {
    try {
      const parsed = new URL(trimmed);
      const kind =
        parsed.protocol === 'https:'
          ? 'https'
          : parsed.protocol === 'http:'
            ? 'http'
            : parsed.protocol === 'ssh:'
              ? 'ssh'
              : undefined;
      return kind === undefined ? undefined : { kind, host: parsed.host.toLowerCase() };
    } catch {
      return undefined;
    }
  }
  // scp-like `user@host:path`: a colon before any slash, and not a Windows drive.
  const scp = /^(?:[^@/]+@)?([^:/]+):(?!\/\/)/u.exec(trimmed);
  if (scp !== null && scp[1] !== undefined && scp[1].length > 1) return { kind: 'ssh', host: scp[1].toLowerCase() };
  return undefined;
}

/** Quotes one word for the POSIX shell git runs GIT_SSH_COMMAND through. */
function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

/**
 * The environment for one fetch or push against `remoteUrl`.
 *
 * Every call drops tracing (which can log credentials) and turns prompts off,
 * because no terminal is attached. Only when the workspace's method matches the
 * remote does anything secret go in, and then only into this child's env.
 */
export function remoteEnv(
  config: GitAuthConfig,
  remoteUrl: string,
  baseEnv: NodeJS.ProcessEnv,
  homeDir: string,
): RemoteEnv {
  const env: NodeJS.ProcessEnv = { ...baseEnv };
  for (const key of Object.keys(env)) {
    if (STRIPPED_ALWAYS.includes(key) || STRIPPED_PREFIXES.some((prefix) => key.startsWith(prefix))) delete env[key];
  }
  env.GIT_TERMINAL_PROMPT = '0';
  env.GCM_INTERACTIVE = 'never';

  const transport = remoteTransport(remoteUrl);
  const credentialed = (): void => {
    for (const key of Object.keys(env)) {
      if (STRIPPED_CREDENTIALED.includes(key) || CONFIG_ENTRY.test(key)) delete env[key];
    }
    // Takes precedence over a core.askPass the repository's own config names.
    env.GIT_ASKPASS = 'true';
  };

  if (config.method === 'https') {
    if (transport?.kind !== 'https' || transport.host !== config.host) {
      return {
        env,
        credentialed: false,
        mismatch: `This workspace's token is for https://${config.host}, and this remote is not.`,
      };
    }
    credentialed();
    env.GIT_CONFIG_COUNT = '3';
    env.GIT_CONFIG_KEY_0 = 'credential.helper';
    env.GIT_CONFIG_VALUE_0 = '';
    env.GIT_CONFIG_KEY_1 = `credential.https://${config.host}.helper`;
    env.GIT_CONFIG_VALUE_1 = ENV_CREDENTIAL_HELPER;
    env.GIT_CONFIG_KEY_2 = 'http.sslVerify';
    env.GIT_CONFIG_VALUE_2 = 'true';
    env.GIT_ALLOW_PROTOCOL = 'https';
    env.DOOMPI_GIT_USERNAME = config.username;
    env.DOOMPI_GIT_TOKEN = config.token;
    return { env, credentialed: true };
  }

  if (config.method === 'ssh') {
    if (transport?.kind !== 'ssh') {
      return { env, credentialed: false, mismatch: 'This workspace uses SSH, and this remote is not an SSH remote.' };
    }
    credentialed();
    const identity =
      config.keyPath === undefined
        ? []
        : ['-i', shellQuote(expandHome(config.keyPath, homeDir)), '-o', 'IdentitiesOnly=yes'];
    // No StrictHostKeyChecking override: an unknown host is refused, and the
    // recovery says to trust it once from a terminal.
    env.GIT_SSH_COMMAND = ['ssh', ...identity, '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=15'].join(' ');
    env.GIT_ALLOW_PROTOCOL = 'ssh';
    return { env, credentialed: true };
  }

  return { env, credentialed: false };
}

export { SETTINGS_HINT };
