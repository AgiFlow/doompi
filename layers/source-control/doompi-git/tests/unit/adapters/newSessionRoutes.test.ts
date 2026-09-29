import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import type { DoomApiContext } from '@agimon-ai/doompi-core/packageApi';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { api } from '../../../src/extensions/(backend)/api/_lib/route.server';

let root: string;

function git(cwd: string, ...args: string[]): void {
  execFileSync('git', args, { cwd, stdio: 'ignore' });
}

function context(overrides: Partial<DoomApiContext> = {}): DoomApiContext {
  return {
    scope: 'workspace',
    workspaceId: 'ws',
    workspaceRoot: root,
    onNotice: vi.fn(),
    directEvents: { publish: vi.fn(), subscribe: vi.fn(), close: vi.fn() },
    sessionService: { create: vi.fn(), close: vi.fn(), isLive: () => false },
    ...overrides,
  } as unknown as DoomApiContext;
}

function request(method: string, pathname: string, body?: unknown): Request {
  return new Request(`http://git.local${pathname}`, {
    method,
    ...(body === undefined ? {} : { body: JSON.stringify(body), headers: { 'content-type': 'application/json' } }),
  });
}

beforeEach(() => {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'doompi-git-routes-')));
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

describe('new-session dialog routes', () => {
  it('lists the workspace branches, and reports a workspace that is not a git checkout', async () => {
    const plain = api.start(context());
    expect(await (await plain.fetch(request('GET', '/branches'))).json()).toEqual({
      repository: false,
      local: [],
      remote: [],
    });

    git(root, 'init', '-q', '-b', 'main');
    git(root, 'config', 'user.email', 'test@example.com');
    git(root, 'config', 'user.name', 'Test');
    git(root, 'config', 'commit.gpgsign', 'false');
    fs.writeFileSync(path.join(root, 'file.txt'), 'one\n');
    git(root, 'add', 'file.txt');
    git(root, 'commit', '-q', '-m', 'init');
    git(root, 'branch', 'feature/existing');

    const listed = (await (await api.start(context()).fetch(request('GET', '/branches'))).json()) as {
      repository: boolean;
      current?: string;
      local: { name: string }[];
    };
    expect(listed).toMatchObject({ repository: true, current: 'main', defaultBase: 'main' });
    expect(listed.local.map((branch) => branch.name).sort()).toEqual(['feature/existing', 'main']);
  });

  it('returns a useful conflict for a duplicate new branch without starting a session', async () => {
    git(root, 'init', '-q', '-b', 'main');
    git(root, 'config', 'user.email', 'test@example.com');
    git(root, 'config', 'user.name', 'Test');
    git(root, 'config', 'commit.gpgsign', 'false');
    fs.writeFileSync(path.join(root, 'file.txt'), 'one\n');
    git(root, 'add', 'file.txt');
    git(root, 'commit', '-q', '-m', 'init');
    git(root, 'branch', 'feature/existing');
    const created = context();

    const response = await api
      .start(created)
      .fetch(request('POST', '/sessions', { mode: 'new-branch', branch: 'feature/existing', baseRef: 'main' }));

    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({
      code: 'invalid_request',
      error: expect.stringContaining('The branch feature/existing already exists.'),
    });
    expect(created.sessionService?.create).not.toHaveBeenCalled();
  });

  it('refuses an invalid create request before any git work', async () => {
    const created = context();
    const handler = api.start(created);

    const refused = await handler.fetch(request('POST', '/sessions', { mode: 'new-branch', branch: '--x' }));
    expect(refused.status).toBe(400);
    expect(await refused.json()).toEqual({ error: 'A valid branch name is required.' });
    expect((await handler.fetch(request('POST', '/sessions', { mode: 'plain', branch: 'ok' }))).status).toBe(400);
    expect(created.sessionService?.create).not.toHaveBeenCalled();
  });

  it('answers only at workspace scope, never rooted anywhere the request names', async () => {
    const global = api.start(context({ scope: 'global', workspaceRoot: undefined }));
    expect((await global.fetch(request('GET', '/branches'))).status).toBe(404);
    const session = api.start(context({ scope: 'session', cwd: root }));
    expect((await session.fetch(request('POST', '/sessions', { mode: 'new-branch', branch: 'x' }))).status).toBe(404);
  });
});
