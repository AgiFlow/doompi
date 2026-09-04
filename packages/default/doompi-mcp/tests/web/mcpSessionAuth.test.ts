import { renderPlugin, slotPropsFixture } from '@agimon-ai/doompi-web-contracts/testing';
import { describe, expect, it, vi } from 'vitest';
import {
  formatMcpSessionAuthStatus,
  MCP_SESSION_AUTH_STATUS_KEY,
  parseMcpSessionAuthStatus,
} from '../../src/types/webMcp.ts';
import { McpSessionAuthSection, requestMcpSessionAuthorization } from '../../src/web/McpSessionAuthSection.tsx';

describe('MCP live-session authorization status', () => {
  it('serializes only server names that need authorization', () => {
    const status = formatMcpSessionAuthStatus([
      { name: 'ready', state: 'connected', error: 'not part of the wire contract' },
      { name: 'github', state: 'needs-auth', error: 'token=secret' },
    ]);

    expect(status).toBe(JSON.stringify([{ name: 'github', state: 'needs-auth' }]));
    expect(status).not.toContain('secret');
    expect(status).not.toContain('ready');
    expect(formatMcpSessionAuthStatus([{ name: 'ready', state: 'connected' }])).toBeUndefined();
  });

  it('treats absent and browser-cleared statuses as absent and rejects malformed rows', () => {
    expect(parseMcpSessionAuthStatus(undefined)).toBeUndefined();
    expect(parseMcpSessionAuthStatus('')).toBeUndefined();
    expect(parseMcpSessionAuthStatus('   ')).toBeUndefined();
    expect(parseMcpSessionAuthStatus('not json')).toBeUndefined();
    expect(parseMcpSessionAuthStatus(JSON.stringify([{ name: 'github', state: 'connected' }]))).toBeUndefined();
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
    expect(rendered.includes('MCP authorization')).toBe(true);
    expect(rendered.includes('Authorization links appear in the session transcript.')).toBe(true);
    expect(rendered.includes('github')).toBe(true);
    expect(rendered.includes('linear')).toBe(true);
    expect(rendered.html.match(/>authorize<\/button>/gu)).toHaveLength(2);
    expect(rendered.html).toContain('aria-label="Authorize github"');
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
