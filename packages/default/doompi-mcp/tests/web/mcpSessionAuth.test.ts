import { renderPlugin, slotPropsFixture } from '@agimon-ai/doompi-web-contracts/testing';
import { describe, expect, it, vi } from 'vitest';
import {
  formatMcpSessionAuthStatus,
  MCP_SESSION_AUTH_STATUS_KEY,
  parseMcpSessionAuthStatus,
} from '../../src/types/webMcp.ts';
import { McpSessionAuthSection, requestMcpSessionAuthorization } from '../../src/web/McpSessionAuthSection.tsx';

describe('MCP live-session authorization status', () => {
  it('serializes connected completion and safe authorization URLs without diagnostics', () => {
    const authorizationUrl = 'https://auth.example.test/authorize?state=waiting';
    const status = formatMcpSessionAuthStatus([
      { name: 'ready', state: 'connected', error: 'not part of the wire contract' },
      { name: 'github', state: 'needs-auth', authorizationUrl, error: 'token=secret' },
    ]);

    expect(parseMcpSessionAuthStatus(status)).toEqual([
      { name: 'ready', state: 'connected' },
      { name: 'github', state: 'needs-auth', authorizationUrl },
    ]);
    expect(status).not.toContain('secret');
    expect(formatMcpSessionAuthStatus([])).toBeUndefined();
  });

  it.each([
    'javascript:alert(1)',
    'file:///tmp/secret',
    'https://user:password@auth.example.test/',
    'https://user@auth.example.test/',
    'https://auth.example.test/\nredirect',
    `https://auth.example.test/${String.fromCharCode(127)}`,
    `https://auth.example.test/${'a'.repeat(8192)}`,
    '/relative',
    123,
    null,
  ])('rejects unsafe authorization URL %s', (authorizationUrl) => {
    const row = { name: 'github', state: 'needs-auth', authorizationUrl };
    expect(parseMcpSessionAuthStatus(JSON.stringify([row]))).toBeUndefined();
    expect(parseMcpSessionAuthStatus(formatMcpSessionAuthStatus([row]))).toEqual([
      { name: 'github', state: 'needs-auth' },
    ]);
  });

  it('accepts HTTP callback authorization pages', () => {
    const rows = [{ name: 'local', state: 'connecting', authorizationUrl: 'http://localhost:8080/authorize' }];
    expect(parseMcpSessionAuthStatus(formatMcpSessionAuthStatus(rows))).toEqual(rows);
  });

  it('keeps undiscovered and failed servers visible without exposing diagnostics', () => {
    const servers = [
      { name: 'agiflow-mcp', state: 'not-connected', tools: [] },
      { name: 'boomlink-mcp', state: 'failed', tools: [], error: 'token=secret' },
      { name: 'pending', state: 'connecting', tools: [] },
    ];
    const status = formatMcpSessionAuthStatus(servers);
    expect(parseMcpSessionAuthStatus(status)).toEqual(servers.map(({ name, state }) => ({ name, state })));
    expect(status).not.toContain('secret');
  });

  it('treats absent and browser-cleared statuses as absent and rejects malformed rows', () => {
    expect(parseMcpSessionAuthStatus(undefined)).toBeUndefined();
    expect(parseMcpSessionAuthStatus('')).toBeUndefined();
    expect(parseMcpSessionAuthStatus('   ')).toBeUndefined();
    expect(parseMcpSessionAuthStatus('not json')).toBeUndefined();
    expect(parseMcpSessionAuthStatus(JSON.stringify([{ name: 'github', state: 'unknown' }]))).toBeUndefined();
    expect(
      parseMcpSessionAuthStatus(JSON.stringify([{ name: 'github', state: 'needs-auth', error: 'secret' }])),
    ).toBeUndefined();
    expect(parseMcpSessionAuthStatus(JSON.stringify([{ name: 'github\n', state: 'needs-auth' }]))).toBeUndefined();
    expect(
      parseMcpSessionAuthStatus(
        JSON.stringify([
          { name: 'github', state: 'needs-auth' },
          { name: 'github', state: 'needs-auth' },
        ]),
      ),
    ).toBeUndefined();
    expect(
      parseMcpSessionAuthStatus(
        JSON.stringify(Array.from({ length: 129 }, (_, index) => ({ name: `server-${index}`, state: 'needs-auth' }))),
      ),
    ).toBeUndefined();
  });

  it.each([{}, [], [null], [42], [[]], [{ state: 'connected' }], [{ name: ' ', state: 'connected' }]])(
    'rejects malformed connected-server status %j',
    (value) => {
      expect(parseMcpSessionAuthStatus(JSON.stringify(value))).toBeUndefined();
    },
  );

  it('retains connected servers when an unrecognized runtime state is omitted', () => {
    expect(
      parseMcpSessionAuthStatus(
        formatMcpSessionAuthStatus([
          { name: 'ready', state: 'connected' },
          { name: 'unsupported', state: 'unknown' },
        ]),
      ),
    ).toEqual([{ name: 'ready', state: 'connected' }]);
  });

  it('accepts terminal ANSI decoration around a valid status', () => {
    const escape = String.fromCharCode(27);
    const status = JSON.stringify([{ name: 'github', state: 'needs-auth' }]);

    expect(parseMcpSessionAuthStatus(`${escape}[33m${status}${escape}[0m`)).toEqual([
      { name: 'github', state: 'needs-auth' },
    ]);
  });
});

describe('MCP session authorization Context section', () => {
  it('renders one action per needs-auth server', () => {
    const status = JSON.stringify([
      { name: 'github', state: 'needs-auth' },
      { name: 'linear', state: 'needs-auth' },
    ]);
    const rendered = renderPlugin(
      McpSessionAuthSection,
      slotPropsFixture({ statuses: { [MCP_SESSION_AUTH_STATUS_KEY]: status } }).props,
    );

    expect(rendered.error).toBeUndefined();
    expect(rendered.includes('MCP servers')).toBe(true);
    expect(rendered.includes('copy the link from the authorization dialog')).toBe(true);
    expect(rendered.includes('github')).toBe(true);
    expect(rendered.includes('linear')).toBe(true);
    expect(rendered.html.match(/>authorize<\/button>/gu)).toHaveLength(2);
    expect(rendered.html).toContain('aria-label="Authorize github"');
  });

  it('offers authorization before discovery and after a failed connection', () => {
    const status = formatMcpSessionAuthStatus([
      { name: 'agiflow-mcp', state: 'not-connected', tools: [] },
      { name: 'boomlink-mcp', state: 'failed', tools: [] },
    ]);
    const rendered = renderPlugin(
      McpSessionAuthSection,
      slotPropsFixture({ statuses: { [MCP_SESSION_AUTH_STATUS_KEY]: status! } }).props,
    );
    expect(rendered.error).toBeUndefined();
    expect(rendered.html).toContain('aria-label="Authorize agiflow-mcp"');
    expect(rendered.html).toContain('aria-label="Authorize boomlink-mcp"');
    expect(rendered.includes('not connected')).toBe(true);
    expect(rendered.includes('failed')).toBe(true);
  });

  it('nests each MCP tool beneath its owning server and reports empty discovery', () => {
    const status = formatMcpSessionAuthStatus([
      { name: 'pencil', state: 'connected' },
      { name: 'agiflow-mcp', state: 'connected' },
    ]);
    const rendered = renderPlugin(
      McpSessionAuthSection,
      slotPropsFixture({
        statuses: { [MCP_SESSION_AUTH_STATUS_KEY]: status! },
        contextInventory: [
          { name: 'pencil_execute', itemKind: 'tool', source: 'mcp', owner: 'pencil', tokens: 320, active: true },
          { name: 'read', itemKind: 'tool', source: 'extension', owner: 'doompi-read', tokens: 100, active: true },
        ],
      }).props,
    );
    expect(rendered.error).toBeUndefined();
    expect(rendered.html).toContain('aria-label="pencil tools"');
    expect(rendered.includes('pencil_execute')).toBe(true);
    expect(rendered.includes('~320')).toBe(true);
    expect(rendered.includes('read')).toBe(false);
    expect(rendered.includes('no tools reported')).toBe(true);
  });

  it('keeps a connected zero-tool server visible and offers management', () => {
    const status = formatMcpSessionAuthStatus([{ name: 'agiflow-mcp', state: 'connected', tools: [] }]);
    const rendered = renderPlugin(
      McpSessionAuthSection,
      slotPropsFixture({ statuses: { [MCP_SESSION_AUTH_STATUS_KEY]: status! } }).props,
    );
    expect(rendered.error).toBeUndefined();
    expect(rendered.includes('agiflow-mcp')).toBe(true);
    expect(rendered.includes('connected')).toBe(true);
    expect(rendered.html).toContain('aria-label="Manage agiflow-mcp"');
    expect(rendered.html).not.toContain('aria-label="Authorize agiflow-mcp"');
  });

  it.each([
    { sessionId: null, state: 'connected' },
    { sessionId: 'session-1', state: 'disabled' },
  ])('keeps the server visible but disables unsafe actions for %j', ({ sessionId, state }) => {
    const status = formatMcpSessionAuthStatus([{ name: 'agiflow-mcp', state }]);
    const rendered = renderPlugin(
      McpSessionAuthSection,
      slotPropsFixture({ sessionId, statuses: { [MCP_SESSION_AUTH_STATUS_KEY]: status! } }).props,
    );
    expect(rendered.error).toBeUndefined();
    expect(rendered.includes('agiflow-mcp')).toBe(true);
    expect(rendered.html).toMatch(/<button[^>]*disabled/);
  });

  it('renders nothing for an absent or browser-cleared status', () => {
    expect(renderPlugin(McpSessionAuthSection, slotPropsFixture().props).html).toBe('');
    expect(
      renderPlugin(McpSessionAuthSection, slotPropsFixture({ statuses: { [MCP_SESSION_AUTH_STATUS_KEY]: '' } }).props)
        .html,
    ).toBe('');
  });

  it('sends one direct prompt frame with command-like punctuation without opening a browser or shell', () => {
    const send = vi.fn();
    const open = vi.fn();

    requestMcpSessionAuthorization(send, 'session-1', 'github; echo owned');

    expect(send).toHaveBeenCalledOnce();
    expect(send).toHaveBeenCalledWith('session-1', {
      type: 'prompt',
      message: '/mcp auth github; echo owned',
    });
    expect(open).not.toHaveBeenCalled();
  });
});
