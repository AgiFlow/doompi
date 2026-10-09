import fs from 'node:fs';
import path from 'node:path';

import type { DoomApiContext } from '@agimon-ai/doompi-core/packageApi';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { api } from '../../../src/extensions/(backend)/api/git/_lib/route.server';
import { createGitSandbox, type GitSandbox } from '../../support/gitSandbox';

const { reviewCall } = vi.hoisted(() => ({ reviewCall: vi.fn() }));
vi.mock('../../../src/services/branchDiff', async (importOriginal) => {
  const original = await importOriginal<typeof import('../../../src/services/branchDiff')>();
  return {
    ...original,
    createBranchDiff: () => {
      const real = original.createBranchDiff();
      return {
        ...real,
        review: (...args: Parameters<typeof real.review>) => reviewCall(() => real.review(...args)),
      };
    },
  };
});

let sandbox: GitSandbox;
let repo: string;

function context(overrides: Partial<DoomApiContext>): DoomApiContext {
  return {
    homeDirectory: sandbox.root,
    onNotice: vi.fn(),
    directEvents: { publish: vi.fn(), subscribe: vi.fn(), close: vi.fn() },
    sessionService: { create: vi.fn(), close: vi.fn(), isLive: () => false },
    resolveRepository: (id: string) => (id === 'repo-1' ? repo : undefined),
    ...overrides,
  } as unknown as DoomApiContext;
}

async function call(ctx: DoomApiContext, method: string, pathname: string, body?: unknown): Promise<Response> {
  return await api.start(ctx).fetch(
    new Request(`http://git.local${pathname}`, {
      method,
      ...(body === undefined ? {} : { body: JSON.stringify(body), headers: { 'content-type': 'application/json' } }),
    }),
  );
}

beforeEach(() => {
  reviewCall.mockReset().mockImplementation((run: () => Promise<unknown>) => run());
  sandbox = createGitSandbox('doompi-git-routes2-');
  vi.stubEnv('GIT_CONFIG_GLOBAL', sandbox.env.GIT_CONFIG_GLOBAL!);
  vi.stubEnv('GIT_CONFIG_NOSYSTEM', '1');
  repo = sandbox.repository('repo');
});

afterEach(() => {
  vi.unstubAllEnvs();
  sandbox.dispose();
});

describe('workspace auth route', () => {
  const workspace = () =>
    context({ scope: 'workspace', workspaceId: 'repo-1', workspaceRoot: repo } as Partial<DoomApiContext>);

  it('saves and reads a workspace setup without ever returning the token', async () => {
    const saved = await call(workspace(), 'PUT', '/auth?repositoryId=repo-1', {
      method: 'https',
      host: 'github.com',
      username: 'vngo',
      token: 'ghp_secret',
    });
    expect(saved.status).toBe(200);
    const text = await saved.text();
    expect(text).not.toContain('ghp_secret');
    expect(JSON.parse(text)).toEqual({
      method: 'https',
      https: { host: 'github.com', username: 'vngo', hasToken: true },
    });
    expect(await (await call(workspace(), 'GET', '/auth?repositoryId=repo-1')).json()).toMatchObject({
      method: 'https',
    });
  });

  it('answers a bad save with a plain 400, and an unknown repository with 400', async () => {
    const bad = await call(workspace(), 'PUT', '/auth?repositoryId=repo-1', {
      method: 'https',
      host: 'github.com',
      username: 'v',
    });
    expect(bad.status).toBe(400);
    expect(((await bad.json()) as { error: string }).error).toBe(
      'A token is required. Enter the personal access token for this host.',
    );
    expect((await call(workspace(), 'GET', '/auth?repositoryId=nope')).status).toBe(400);
  });

  it('does not exist on a global or session mount, so the gated workspace URL is the only way in', async () => {
    expect(
      (
        await call(context({ scope: 'global' } as Partial<DoomApiContext>), 'PUT', '/auth?repositoryId=repo-1', {
          method: 'none',
        })
      ).status,
    ).toBe(404);
    expect(
      (
        await call(
          context({ scope: 'session', sessionId: 's1', cwd: repo } as Partial<DoomApiContext>),
          'GET',
          '/auth?repositoryId=repo-1',
        )
      ).status,
    ).toBe(404);
  });
});

describe('session review routes', () => {
  const session = () => context({ scope: 'session', sessionId: 's1', cwd: repo } as Partial<DoomApiContext>);

  it("lists the session's changes and serves only files in that list", async () => {
    fs.writeFileSync(path.join(repo, 'README.md'), '# changed\n');
    const summary = (await (await call(session(), 'GET', '/review')).json()) as {
      repository: boolean;
      files: { path: string }[];
    };
    expect(summary.repository).toBe(true);
    expect(summary.files.map((file) => file.path)).toEqual(['README.md']);

    const file = await call(session(), 'GET', '/review/file?path=README.md');
    expect(file.status).toBe(200);
    expect(((await file.json()) as { hunks: unknown[] }).hunks).toHaveLength(1);
    expect((await call(session(), 'GET', `/review/file?path=${encodeURIComponent('../secret')}`)).status).toBe(404);
    expect((await call(session(), 'GET', '/review/file?path=--output=x')).status).toBe(404);
  });

  it('shares overlapping reviews, then recomputes after settlement', async () => {
    fs.writeFileSync(path.join(repo, 'README.md'), '# changed\n');
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    reviewCall.mockImplementationOnce(async (run: () => Promise<unknown>) => {
      await gate;
      return run();
    });
    const handler = api.start(session());
    const request = (pathname: string) => Promise.resolve(handler.fetch(new Request(`http://git.local${pathname}`)));
    const responses = [
      request('/review'),
      request('/review/file?path=README.md'),
      request('/review/file?path=../secret'),
    ];
    await vi.waitFor(() => expect(reviewCall).toHaveBeenCalledTimes(1));
    release();
    expect((await Promise.all(responses)).map((response) => response.status)).toEqual([200, 200, 404]);
    expect((await request('/review')).status).toBe(200);
    expect(reviewCall).toHaveBeenCalledTimes(2);
  });

  it('removes a failed in-flight review so the next request can retry', async () => {
    reviewCall.mockRejectedValueOnce(new Error('read failed'));
    const handler = api.start(session());
    const request = () => handler.fetch(new Request('http://git.local/review'));
    expect((await request()).status).toBe(500);
    expect((await request()).status).toBe(200);
    expect(reviewCall).toHaveBeenCalledTimes(2);
  });

  it('reports a session outside a repository, and does not exist on a workspace mount', async () => {
    const plain = path.join(sandbox.root, 'plain');
    fs.mkdirSync(plain);
    const outside = context({ scope: 'session', sessionId: 's2', cwd: plain } as Partial<DoomApiContext>);
    expect(await (await call(outside, 'GET', '/review')).json()).toEqual({ repository: false, files: [] });
    expect(
      (await call(context({ scope: 'workspace', workspaceRoot: repo } as Partial<DoomApiContext>), 'GET', '/review'))
        .status,
    ).toBe(404);
  });
});
