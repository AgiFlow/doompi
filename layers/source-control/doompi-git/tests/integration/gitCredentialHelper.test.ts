import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { remoteEnv } from '../../src/services/gitAuth';
import { createGitSandbox, type GitSandbox } from '../support/gitSandbox';

/**
 * The offline proof behind "never in the keychain": with a credential helper
 * configured globally, as osxkeychain is on macOS, the workspace token is
 * answered from the environment and no other helper ever receives it.
 *
 * A file-backed `store` helper stands in for the keychain, so the test can read
 * what a helper would have saved. GIT_CONFIG_NOSYSTEM keeps the real keychain
 * out of the run.
 */
let sandbox: GitSandbox;
let leak: string;

function credential(env: NodeJS.ProcessEnv, action: 'fill' | 'approve', input: string): string {
  try {
    return execFileSync('git', ['credential', action], {
      cwd: sandbox.root,
      input,
      encoding: 'utf8',
      env,
      stdio: 'pipe',
    });
  } catch (error) {
    // A host nobody answers for makes `fill` exit non-zero; what it printed is the evidence.
    const stdout = (error as { stdout?: unknown }).stdout;
    return typeof stdout === 'string' ? stdout : '';
  }
}

beforeEach(() => {
  sandbox = createGitSandbox('doompi-git-cred-');
  leak = path.join(sandbox.root, 'leaked-credentials');
  fs.appendFileSync(sandbox.env.GIT_CONFIG_GLOBAL!, `[credential]\n\thelper = store --file=${leak}\n`);
});

afterEach(() => sandbox.dispose());

describe('the inline credential helper', () => {
  const config = { method: 'https', host: 'github.com', username: 'vngo', token: 'ghp_secret' } as const;

  it('answers from the environment and leaves every other helper empty', () => {
    const { env } = remoteEnv(config, 'https://github.com/org/repo.git', sandbox.env, sandbox.root);
    const filled = credential(env, 'fill', 'protocol=https\nhost=github.com\npath=org/repo.git\n\n');
    expect(filled).toContain('username=vngo');
    expect(filled).toContain('password=ghp_secret');

    // What git does after a successful push: hand the credential to every helper to store.
    credential(env, 'approve', filled);
    expect(fs.existsSync(leak) ? fs.readFileSync(leak, 'utf8') : '').toBe('');
  });

  it('answers nothing for another host', () => {
    const { env } = remoteEnv(config, 'https://github.com/org/repo.git', sandbox.env, sandbox.root);
    const filled = credential(
      { ...env, GIT_TERMINAL_PROMPT: '0' },
      'fill',
      'protocol=https\nhost=evil.example\n\n',
    ).trim();
    expect(filled).not.toContain('ghp_secret');
  });
});
