import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { DoomGitExpectedError } from '../../../src/services/errors';
import { createGitAuthStore, publicView, remoteEnv, remoteTransport } from '../../../src/services/gitAuth';
import { credentialsFile, doomGitRoot } from '../../../src/services/paths';

let home: string;
let workspace: string;

beforeEach(() => {
  home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'doompi-git-auth-home-')));
  workspace = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'doompi-git-auth-ws-')));
});

afterEach(() => {
  fs.rmSync(home, { recursive: true, force: true });
  fs.rmSync(workspace, { recursive: true, force: true });
});

const HTTPS = { method: 'https', host: 'github.com', username: 'vngo', token: 'ghp_secret' } as const;

describe('git auth store', () => {
  it('starts as none, saves per workspace, and never hands the token back', () => {
    const store = createGitAuthStore(home);
    expect(store.view(workspace)).toEqual({ method: 'none' });

    const view = store.save(workspace, HTTPS);
    expect(view).toEqual({ method: 'https', https: { host: 'github.com', username: 'vngo', hasToken: true } });
    expect(JSON.stringify(view)).not.toContain('ghp_secret');
    expect(JSON.stringify(store.view(workspace))).not.toContain('ghp_secret');
    expect(store.read(workspace)).toEqual(HTTPS);

    const other = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'doompi-git-auth-other-')));
    try {
      expect(store.view(other)).toEqual({ method: 'none' });
    } finally {
      fs.rmSync(other, { recursive: true, force: true });
    }
  });

  it('writes the file 0600 in a 0700 folder, and repairs a loosened file on read', () => {
    const store = createGitAuthStore(home);
    store.save(workspace, HTTPS);
    expect(fs.statSync(credentialsFile(home)).mode & 0o777).toBe(0o600);
    expect(fs.statSync(doomGitRoot(home)).mode & 0o777).toBe(0o700);

    fs.chmodSync(credentialsFile(home), 0o644);
    store.read(workspace);
    expect(fs.statSync(credentialsFile(home)).mode & 0o777).toBe(0o600);
  });

  it('keeps the saved token for the same host and refuses to carry it to another', () => {
    const store = createGitAuthStore(home);
    store.save(workspace, HTTPS);
    store.save(workspace, { method: 'https', host: 'github.com', username: 'renamed' });
    expect(store.read(workspace)).toEqual({ ...HTTPS, username: 'renamed' });

    expect(() => store.save(workspace, { method: 'https', host: 'gitlab.com', username: 'vngo' })).toThrow(
      DoomGitExpectedError,
    );
    expect(store.read(workspace)).toEqual({ ...HTTPS, username: 'renamed' });
  });

  it('rejects control characters, bad hosts and missing key files', () => {
    const store = createGitAuthStore(home);
    expect(() => store.save(workspace, { ...HTTPS, token: 'abc\nusername=evil' })).toThrow(/plain text/u);
    expect(() => store.save(workspace, { ...HTTPS, host: 'not a host' })).toThrow(/host/u);
    expect(() => store.save(workspace, { method: 'ssh', keyPath: 'relative/key' })).toThrow(/absolute/u);
    expect(() => store.save(workspace, { method: 'ssh', keyPath: '~/.ssh/missing' })).toThrow(/No key file/u);

    fs.mkdirSync(path.join(home, '.ssh'));
    fs.writeFileSync(path.join(home, '.ssh', 'id_test'), 'key');
    expect(store.save(workspace, { method: 'ssh', keyPath: '~/.ssh/id_test' })).toEqual({
      method: 'ssh',
      ssh: { keyPath: '~/.ssh/id_test' },
    });
  });

  it('forgets a workspace when it goes back to none, and ignores a malformed file', () => {
    const store = createGitAuthStore(home);
    store.save(workspace, HTTPS);
    store.save(workspace, { method: 'none' });
    expect(store.read(workspace)).toEqual({ method: 'none' });

    fs.writeFileSync(credentialsFile(home), '{not json');
    expect(store.read(workspace)).toEqual({ method: 'none' });
  });

  it('shows an ssh setup without a key as the agent default', () => {
    expect(publicView({ method: 'ssh' })).toEqual({ method: 'ssh', ssh: {} });
  });
});

describe('remote transport', () => {
  it('reads https, http, ssh and scp-like remotes, and nothing from a local path', () => {
    expect(remoteTransport('https://GitHub.com/org/repo.git')).toEqual({ kind: 'https', host: 'github.com' });
    expect(remoteTransport('https://git.example.com:8443/repo')).toEqual({
      kind: 'https',
      host: 'git.example.com:8443',
    });
    expect(remoteTransport('http://example.com/repo')).toEqual({ kind: 'http', host: 'example.com' });
    expect(remoteTransport('ssh://git@github.com/org/repo.git')).toEqual({ kind: 'ssh', host: 'github.com' });
    expect(remoteTransport('git@github.com:org/repo.git')).toEqual({ kind: 'ssh', host: 'github.com' });
    expect(remoteTransport('/srv/git/repo.git')).toBeUndefined();
    expect(remoteTransport('C:\\repos\\x')).toBeUndefined();
  });
});

describe('remote env', () => {
  const base = {
    PATH: '/usr/bin',
    GIT_TRACE: '1',
    GIT_TRACE_CURL: '1',
    GIT_CURL_VERBOSE: '1',
    GIT_ASKPASS: '/vscode/askpass',
    GIT_CONFIG_COUNT: '1',
    GIT_CONFIG_KEY_0: 'http.proxy',
    GIT_CONFIG_VALUE_0: 'http://evil',
  };

  it('puts the token only into this child, only for its host, and empties the helper list first', () => {
    const { env, credentialed } = remoteEnv(HTTPS, 'https://github.com/org/repo.git', base, home);
    expect(credentialed).toBe(true);
    expect(env.DOOMPI_GIT_TOKEN).toBe('ghp_secret');
    expect(env.GIT_CONFIG_COUNT).toBe('3');
    expect([env.GIT_CONFIG_KEY_0, env.GIT_CONFIG_VALUE_0]).toEqual(['credential.helper', '']);
    expect(env.GIT_CONFIG_KEY_1).toBe('credential.https://github.com.helper');
    expect(env.GIT_CONFIG_VALUE_1).not.toContain('ghp_secret');
    expect([env.GIT_CONFIG_KEY_2, env.GIT_CONFIG_VALUE_2]).toEqual(['http.sslVerify', 'true']);
    expect(env.GIT_ALLOW_PROTOCOL).toBe('https');
    expect(env.GIT_ASKPASS).toBe('true');
    expect(env.GIT_TERMINAL_PROMPT).toBe('0');
    for (const key of ['GIT_TRACE', 'GIT_TRACE_CURL', 'GIT_CURL_VERBOSE']) expect(env[key]).toBeUndefined();
    expect(process.env.DOOMPI_GIT_TOKEN).toBeUndefined();
  });

  it('keeps the token away from any other host or transport', () => {
    for (const url of [
      'https://gitlab.com/org/repo.git',
      'http://github.com/org/repo.git',
      'git@github.com:org/repo.git',
    ]) {
      const { env, credentialed, mismatch } = remoteEnv(HTTPS, url, base, home);
      expect(credentialed).toBe(false);
      expect(env.DOOMPI_GIT_TOKEN).toBeUndefined();
      expect(mismatch).toContain('github.com');
      // This machine's own git setup is left alone.
      expect(env.GIT_ASKPASS).toBe('/vscode/askpass');
    }
  });

  it('runs ssh in batch mode with the quoted key, and leaves host keys to known_hosts', () => {
    const { env } = remoteEnv(
      { method: 'ssh', keyPath: "~/keys/it's mine" },
      'git@github.com:org/repo.git',
      base,
      home,
    );
    expect(env.GIT_SSH_COMMAND).toBe(
      `ssh -i '${home}/keys/it'\\''s mine' -o IdentitiesOnly=yes -o BatchMode=yes -o ConnectTimeout=15`,
    );
    expect(env.GIT_SSH_COMMAND).not.toContain('StrictHostKeyChecking');
    expect(env.GIT_ALLOW_PROTOCOL).toBe('ssh');
    expect(remoteEnv({ method: 'ssh' }, 'git@github.com:o/r', base, home).env.GIT_SSH_COMMAND).toBe(
      'ssh -o BatchMode=yes -o ConnectTimeout=15',
    );
  });

  it("only turns prompts off for this machine's own git", () => {
    const { env, credentialed } = remoteEnv({ method: 'none' }, 'https://github.com/o/r', base, home);
    expect(credentialed).toBe(false);
    expect(env.GIT_TERMINAL_PROMPT).toBe('0');
    expect(env.GIT_CONFIG_COUNT).toBe('1');
  });
});
