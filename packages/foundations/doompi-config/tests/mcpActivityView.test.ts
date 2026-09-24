import { createHash } from 'node:crypto';

import type { DoomMcpPluginContext } from '@agimon-ai/doompi-core/mcpFacet';
import { describe, expect, it } from 'vitest';

import { mcp } from '../generated/mcp';
import { activityAppHtml, activityAppUri } from '../generated/mcp-apps/activity';
import resource from '../src/extensions/workspaces/sessions/(backend)/resource/tool-activity.mcp';

describe('remote tool activity MCP App', () => {
  it('packages exactly one default activity resource alongside the custom session view', async () => {
    const session = typeof mcp.session === 'function' ? await mcp.session({} as DoomMcpPluginContext) : mcp.session;
    const defaults = session.uiResources?.filter((item) => item._meta?.['doompi/defaultToolUi'] === true);
    expect(defaults).toEqual([resource]);
    expect(session.uiResources?.some((item) => item.name === 'doompi-session-view')).toBe(true);
  });

  it('embeds immutable self-contained HTML without granting network access', async () => {
    const html = await resource.read();
    const digest = createHash('sha256').update(html).digest('hex').slice(0, 24);
    expect(html).toBe(activityAppHtml);
    expect(resource.uri).toBe(activityAppUri);
    expect(resource.uri).toBe(`ui://doompi/activity/${digest}/index.html`);
    expect(resource.mimeType).toBe('text/html;profile=mcp-app');
    expect(resource._meta).toMatchObject({
      'doompi/defaultToolUi': true,
      ui: { csp: { connectDomains: [], resourceDomains: [] }, prefersBorder: true },
      'openai/widgetCSP': { connect_domains: [], resource_domains: [] },
    });
    expect(html).toContain('<!doctype html>');
    expect(html).toContain('<script>');
    expect(html).not.toContain('<!--APP_SCRIPT-->');
    expect(html).not.toMatch(/<script[^>]+src=/u);
    expect(html).not.toContain('/Users/');
  });
});
