import { describe, expect, it } from 'vitest';

import { doomApiMountPath } from '../../src/schemas/packageApi';
import { DOOM_PACKAGE_API_PATH_PATTERN } from '../../src/server/headlessServer';
import {
  apiQueryString,
  type ApiScopeAddress,
  pluginApiBase,
  pluginApiUrl,
  scopeApiRoot,
} from '../../src/web/services/apiPaths';

const WORKSPACE = 'ws-1';
const SESSION = 's-1';

const ADDRESSES: readonly ApiScopeAddress[] = [
  { scope: 'global' },
  { scope: 'workspace', workspaceId: WORKSPACE },
  { scope: 'session', workspaceId: WORKSPACE, sessionId: SESSION },
];

describe('scope roots', () => {
  it('spells each scope the way the routing model documents it', () => {
    expect(scopeApiRoot({ scope: 'global' })).toBe('/api');
    expect(scopeApiRoot({ scope: 'workspace', workspaceId: WORKSPACE })).toBe('/api/workspaces/ws-1');
    expect(scopeApiRoot({ scope: 'session', workspaceId: WORKSPACE, sessionId: SESSION })).toBe(
      '/api/workspaces/ws-1/sessions/s-1',
    );
  });

  it('encodes identifiers, so a slash in a name cannot forge a path segment', () => {
    expect(scopeApiRoot({ scope: 'session', workspaceId: 'a/b', sessionId: 'c d' })).toBe(
      '/api/workspaces/a%2Fb/sessions/c%20d',
    );
  });
});

describe('plugin mounts', () => {
  it('puts a package API under /plugins/ at every scope', () => {
    expect(pluginApiBase({ scope: 'global' }, 'file-edits')).toBe('/api/plugins/file-edits');
    expect(pluginApiBase({ scope: 'workspace', workspaceId: WORKSPACE }, 'mcp')).toBe(
      '/api/workspaces/ws-1/plugins/mcp',
    );
    expect(pluginApiBase({ scope: 'session', workspaceId: WORKSPACE, sessionId: SESSION }, 'runner')).toBe(
      '/api/workspaces/ws-1/sessions/s-1/plugins/runner',
    );
  });

  it('hangs a host-owned route off the scope root instead', () => {
    const session = { scope: 'session', workspaceId: WORKSPACE, sessionId: SESSION } as const;
    expect(pluginApiUrl(session, undefined, '/file', { path: 'docs/report.pdf' })).toBe(
      '/api/workspaces/ws-1/sessions/s-1/file?path=docs%2Freport.pdf',
    );
  });

  it('keeps the host settings API beside /plugins, not under it', () => {
    expect(pluginApiBase({ scope: 'global' }, 'settings')).toBe('/api/settings');
    expect(pluginApiBase({ scope: 'workspace', workspaceId: WORKSPACE }, 'settings')).toBe(
      '/api/workspaces/ws-1/settings',
    );
  });

  it("addresses the mount itself when the route path is exactly '/'", () => {
    expect(pluginApiUrl({ scope: 'global' }, 'prompts', '/')).toBe('/api/plugins/prompts');
  });
});

describe('query encoding', () => {
  it('writes a space as %20, which decodes to a space under every parser', () => {
    expect(apiQueryString({ path: 'a b.ts' })).toBe('?path=a%20b.ts');
  });

  it('escapes the characters that would otherwise end the query or start a fragment', () => {
    expect(apiQueryString({ path: 'a&b#c/d' })).toBe('?path=a%26b%23c%2Fd');
  });

  it('drops an undefined value rather than sending the string "undefined"', () => {
    expect(apiQueryString({ a: '1', b: undefined, c: 2 })).toBe('?a=1&c=2');
  });

  it('sends no question mark when nothing survives', () => {
    expect(apiQueryString({ a: undefined })).toBe('');
    expect(apiQueryString(undefined)).toBe('');
  });
});

/**
 * The browser builds these paths and the host parses them, in two halves of
 * this package that cannot import each other. Nothing but this file holds them
 * together.
 */
describe('agreement with the host', () => {
  it('produces the prefix doomApiMountPath produces, for every scope', () => {
    for (const address of ADDRESSES) {
      const mount =
        address.scope === 'session'
          ? doomApiMountPath({ scope: 'session', workspaceId: address.workspaceId, sessionId: address.sessionId })
          : address.scope === 'workspace'
            ? doomApiMountPath({ scope: 'workspace', workspaceId: address.workspaceId })
            : doomApiMountPath({ scope: 'global' });
      expect(`${scopeApiRoot(address)}/plugins`).toBe(mount);
    }
  });

  it('produces paths the host dispatcher matches, and reads back the same identity', () => {
    for (const address of ADDRESSES) {
      const url = pluginApiUrl(address, 'file-edits', '/detail', { path: 'a.ts' });
      const pathname = url.split('?')[0] as string;
      const match = DOOM_PACKAGE_API_PATH_PATTERN.exec(pathname);
      expect(match, pathname).not.toBeNull();
      expect(match?.[3]).toBe('file-edits');
      expect(match?.[4]).toBe('detail');
      if (address.scope !== 'global') expect(decodeURIComponent(match?.[1] ?? '')).toBe(WORKSPACE);
      if (address.scope === 'session') expect(decodeURIComponent(match?.[2] ?? '')).toBe(SESSION);
    }
  });

  it('produces a host settings path the dispatcher still matches', () => {
    const match = DOOM_PACKAGE_API_PATH_PATTERN.exec(pluginApiBase({ scope: 'global' }, 'settings'));
    expect(match).not.toBeNull();
    expect(match?.[3]).toBeUndefined();
  });

  /**
   * The service worker serves anything outside its network allowlist from the
   * signed bundle cache. A plugin URL that stopped starting with `/api/` would
   * be answered with a 404 that looks nothing like a routing mistake.
   */
  it('always starts with /api/, which is what keeps the service worker off it', () => {
    for (const address of ADDRESSES) {
      expect(pluginApiUrl(address, 'file-edits', '/detail')).toMatch(/^\/api\//u);
      expect(pluginApiUrl(address, undefined, '/file')).toMatch(/^\/api\//u);
    }
  });

  it('is root-relative, which is the only form the sealed relay forwards', () => {
    for (const address of ADDRESSES) {
      const url = pluginApiUrl(address, 'voice-media', '/clients', { id: 'a b' });
      expect(url.startsWith('/')).toBe(true);
      expect(url.startsWith('//')).toBe(false);
      expect(url).not.toContain('#');
    }
  });
});

describe('path parameters', () => {
  const session = { scope: 'session', workspaceId: WORKSPACE, sessionId: SESSION } as const;

  it('substitutes a named segment, as Hono spells it', () => {
    expect(pluginApiUrl(session, 'prompts', '/prompts/:name', undefined, { name: 'draft' })).toBe(
      '/api/workspaces/ws-1/sessions/s-1/plugins/prompts/prompts/draft',
    );
  });

  it('encodes per segment, so a slash in a value cannot invent one', () => {
    expect(pluginApiUrl(session, 'prompts', '/prompts/:name', undefined, { name: 'a/b c' })).toBe(
      '/api/workspaces/ws-1/sessions/s-1/plugins/prompts/prompts/a%2Fb%20c',
    );
  });

  it('substitutes every segment of a multi-parameter route', () => {
    expect(
      pluginApiUrl(session, 'runner', '/runners/:runId/log/:kind', undefined, { runId: 'r 1', kind: 'tail' }),
    ).toBe('/api/workspaces/ws-1/sessions/s-1/plugins/runner/runners/r%201/log/tail');
  });

  it('leaves a missing value as the literal segment, which fails at the route rather than silently', () => {
    expect(pluginApiUrl(session, 'prompts', '/prompts/:name', undefined, {})).toContain('/prompts/:name');
  });

  it('carries a query alongside the parameter', () => {
    expect(pluginApiUrl(session, 'prompts', '/prompts/:name', { force: true }, { name: 'x' })).toBe(
      '/api/workspaces/ws-1/sessions/s-1/plugins/prompts/prompts/x?force=true',
    );
  });
});

describe('multi-segment path parameters', () => {
  const session = { scope: 'session', workspaceId: WORKSPACE, sessionId: SESSION } as const;

  it("keeps the slashes inside a Hono ':name{.+}' value, escaping each piece", () => {
    expect(pluginApiUrl(session, 'workflow', '/artifacts/:name{.+}', undefined, { name: 'reports/a b.md' })).toBe(
      '/api/workspaces/ws-1/sessions/s-1/plugins/workflow/artifacts/reports/a%20b.md',
    );
  });

  it('still escapes a slash in a single-segment parameter', () => {
    expect(pluginApiUrl(session, 'workflow', '/runs/:runKey', undefined, { runKey: 'a/b' })).toBe(
      '/api/workspaces/ws-1/sessions/s-1/plugins/workflow/runs/a%2Fb',
    );
  });

  it('leaves a catch-all with no value as its literal segment', () => {
    expect(pluginApiUrl(session, 'workflow', '/artifacts/:name{.+}', undefined, {})).toContain(':name{.+}');
  });
});
