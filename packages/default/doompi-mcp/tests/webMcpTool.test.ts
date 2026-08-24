import { describe, expect, it } from 'vitest';
import { MCP_STATUS_KEY as SESSION_STATUS_KEY } from '../src/adapters/pi/mcpConstants.ts';
import {
  MCP_STATUS_KEY,
  matchMcpTool,
  mcpArgumentSummary,
  mcpIdentityFromDetails,
  mcpResultView,
  mcpServers,
  rememberMcpStatuses,
  rememberedMcpStatuses,
} from '../web/mcpToolMatch.ts';

describe('the mcp web tool matcher', () => {
  it('reads the same status key the session publishes', () => {
    expect(MCP_STATUS_KEY).toBe(SESSION_STATUS_KEY);
  });

  it('lists the published servers and claims tools by the longest server prefix', () => {
    expect(mcpServers({})).toEqual([]);
    expect(mcpServers({ [MCP_STATUS_KEY]: '' })).toEqual([]);
    expect(mcpServers({ [MCP_STATUS_KEY]: 'github, pencil ,' })).toEqual(['github', 'pencil']);

    const statuses = { [MCP_STATUS_KEY]: 'github,github_enterprise' };
    expect(matchMcpTool('github_search', statuses)).toEqual({ server: 'github', tool: 'search' });
    expect(matchMcpTool('github_enterprise_search', statuses)).toEqual({ server: 'github_enterprise', tool: 'search' });
    expect(matchMcpTool('goal_complete', statuses)).toBeNull();
    // A bare server name is not a tool of it.
    expect(matchMcpTool('github_', statuses)).toBeNull();
    expect(matchMcpTool('github_search', {})).toBeNull();
  });

  it('remembers the statuses the matcher last saw for the card', () => {
    expect(rememberedMcpStatuses()).toEqual({});
    rememberMcpStatuses({ [MCP_STATUS_KEY]: 'pencil' });
    expect(rememberedMcpStatuses()).toEqual({ [MCP_STATUS_KEY]: 'pencil' });
  });

  it('prefers the identity the result details carry', () => {
    expect(mcpIdentityFromDetails({ server: 'pencil', tool: 'execute' })).toEqual({
      server: 'pencil',
      tool: 'execute',
    });
    expect(mcpIdentityFromDetails({ server: 'pencil' })).toBeNull();
    expect(mcpIdentityFromDetails(null)).toBeNull();
    expect(mcpIdentityFromDetails('junk')).toBeNull();
  });

  it('summarises the first three arguments', () => {
    expect(mcpArgumentSummary({})).toBe('');
    expect(mcpArgumentSummary({ a: 'x', b: 2, c: true, d: null, e: [1, 2], f: { k: 1 } })).toBe(
      'a=x · b=2 · c=true · +3',
    );
    expect(mcpArgumentSummary({ d: null, e: [1, 2], f: { k: 1 } })).toBe('d=null · e=[2] · f={…}');
  });

  it('lays out the result as text lines and one status line', () => {
    expect(mcpResultView({ output: 'a\nb\n\n', expanded: false, isPartial: true, isError: false })).toEqual({
      lines: ['a', 'b'],
      status: { glyph: '◐', tone: 'running', text: 'running' },
    });
    expect(mcpResultView({ output: 'boom', expanded: false, isPartial: false, isError: true }).status).toEqual({
      glyph: '✗',
      tone: 'error',
      text: 'failed',
    });
    expect(mcpResultView({ output: '', expanded: false, isPartial: false, isError: false })).toEqual({
      lines: [],
      status: { glyph: '✓', tone: 'ok', text: 'done' },
    });
    expect(mcpResultView({ output: 'one', expanded: false, isPartial: false, isError: false })).toEqual({
      lines: ['one'],
      status: null,
    });
    const many = Array.from({ length: 15 }, (_, index) => `l${index}`).join('\n');
    const collapsed = mcpResultView({ output: many, expanded: false, isPartial: false, isError: false });
    expect(collapsed.lines).toHaveLength(12);
    expect(collapsed.status).toEqual({ glyph: '…', tone: 'hint', text: '3 more line(s)' });
    expect(mcpResultView({ output: many, expanded: true, isPartial: false, isError: false }).lines).toHaveLength(15);
  });
});
