import { createHash } from 'node:crypto';

import type { DoomMcpPluginContext } from '@agimon-ai/doompi-core/mcp-facet';
import { Value } from 'typebox/value';
import { describe, expect, it } from 'vitest';

import { sessionAppUri } from '../generated/mcp-apps/session';
import resource from '../src/extensions/workspaces/sessions/(backend)/resource/session-view.mcp';
import showSession from '../src/extensions/workspaces/sessions/(backend)/tool/show_session.mcp';
import { sessionViewSchema } from '../src/schemas/mcpSessionView';
import { createShowSessionTool } from '../src/services/mcpContextTools';

describe('session MCP App', () => {
  it.each(['/private/workspace/doompi', 'C:\\private\\workspace\\doompi'])(
    'projects a fresh summary without instructions or private paths: %s',
    async (root) => {
      let revision = 1;
      const context = {
        loadContext: () => ({
          session: { id: 'child-session', revision },
          repository: { root, cwd: '/private/worktree' },
          selection: {
            profile: 'ponytail',
            domains: ['development'],
            majorMode: 'copilot',
            activeLayers: ['team'],
            minorModes: ['plan'],
          },
          instructions: [{ path: 'AGENTS.md', content: 'private instructions' }],
          persona: 'private persona',
        }),
      } as unknown as DoomMcpPluginContext;
      const tool = createShowSessionTool(context, sessionAppUri);
      expect(tool._meta).toMatchObject({
        ui: { resourceUri: sessionAppUri, visibility: ['model', 'app'] },
        'openai/outputTemplate': sessionAppUri,
      });
      expect(tool.outputSchema).toEqual(sessionViewSchema);
      expect(tool.annotations).toEqual({ readOnlyHint: true, destructiveHint: false, openWorldHint: false });
      const response = await tool.execute('call', {}, undefined, undefined, {} as never);
      expect(response.structuredContent).toEqual({
        sessionId: 'child-session',
        revision: 1,
        repositoryName: 'doompi',
        profile: 'ponytail',
        majorMode: 'copilot',
        domains: ['development'],
        layers: ['team'],
        minorModes: ['plan'],
      });
      expect(Value.Check(sessionViewSchema, response.structuredContent)).toBe(true);
      expect(JSON.stringify(response)).not.toContain('private');
      expect(response.content).toEqual([{ type: 'text', text: expect.stringContaining('Repository: doompi') }]);
      expect(response._meta).toEqual({ widgetType: 'session' });
      revision = 2;
      expect((await tool.execute('refresh', {}, undefined, undefined, {} as never)).structuredContent?.revision).toBe(
        2,
      );
      expect(typeof showSession === 'function' ? showSession(context)._meta : showSession._meta).toEqual(tool._meta);
    },
  );

  it('supports empty/default selections without inventing a profile or mode', async () => {
    const context = {
      loadContext: () => ({
        session: { id: 'session', revision: 0 },
        repository: { root: '/', cwd: '/' },
        selection: { profile: null, domains: [], majorMode: 'copilot', activeLayers: [] },
      }),
    } as unknown as DoomMcpPluginContext;
    const result = await createShowSessionTool(context, sessionAppUri).execute(
      'call',
      {},
      undefined,
      undefined,
      {} as never,
    );
    expect(result.structuredContent).toMatchObject({
      repositoryName: 'Repository',
      profile: null,
      domains: [],
      layers: [],
      minorModes: [],
    });
    expect(JSON.stringify(result.content)).toContain('Profile: Default');
    expect(JSON.stringify(result.content)).toContain('Minor modes: None');
  });

  it('serves self-contained HTML under its exact content-derived URI', async () => {
    const html = await resource.read();
    const digest = createHash('sha256').update(html).digest('hex').slice(0, 24);
    expect(resource.uri).toBe(`ui://doompi/session/${digest}/index.html`);
    expect(resource.mimeType).toBe('text/html;profile=mcp-app');
    expect(resource._meta).toMatchObject({
      ui: { csp: { connectDomains: [], resourceDomains: [] }, prefersBorder: true },
    });
    expect(html).toContain('<!doctype html>');
    expect(html).toContain('<script>');
    expect(html).not.toContain('<!--APP_SCRIPT-->');
    expect(html).not.toMatch(/<script[^>]+src=/u);
    expect(html).not.toContain('/Users/');
  });
});
