import type { ExtensionAPI, ExtensionContext } from '@earendil-works/pi-coding-agent';
import { describe, expect, it, vi } from 'vitest';

import { fastExtension } from '../../src/extensions/fast';

function setup(provider = 'openai-codex', entries: unknown[] = []) {
  const hooks = new Map<string, (event: never, ctx: ExtensionContext) => unknown>();
  let command: Parameters<ExtensionAPI['registerCommand']>[1];
  const appendEntry = vi.fn();
  const pi = {
    on: (name: string, handler: (event: never, ctx: ExtensionContext) => unknown) => hooks.set(name, handler),
    registerCommand: (_name: string, handler: typeof command) => {
      command = handler;
    },
    appendEntry,
  } as unknown as ExtensionAPI;
  const ctx = {
    model: { provider, api: 'openai-codex-responses' },
    sessionManager: { getBranch: () => entries, getSessionId: () => 'session-1' },
    ui: { notify: vi.fn() },
  } as unknown as ExtensionContext;
  fastExtension(pi);
  return {
    appendEntry,
    ctx,
    run: (args: string) => command.handler(args, ctx as never),
    fire: (name: string, payload?: unknown) => hooks.get(name)?.({ payload } as never, ctx),
  };
}

describe('session fast mode', () => {
  it('defaults off, opts into priority only, and disables without adding provider params', async () => {
    const host = setup();
    const payload = { model: 'real-codex', reasoning: { effort: 'high' } };
    expect(host.fire('before_provider_request', payload)).toBeUndefined();
    await host.run('on');
    expect(host.fire('before_provider_request', payload)).toEqual({ ...payload, service_tier: 'priority' });
    expect(host.appendEntry).toHaveBeenCalledWith('doompi.fast-mode', {
      version: 1,
      sessionId: 'session-1',
      enabled: true,
    });
    await host.run('off');
    expect(host.fire('before_provider_request', payload)).toBeUndefined();
    expect(payload).not.toHaveProperty('service_tier');
  });

  it('restores explicit opt-in, resets on a session switch and leaves non-Codex untouched', async () => {
    const entries = [
      { type: 'custom', customType: 'doompi.fast-mode', data: { version: 1, sessionId: 'session-1', enabled: true } },
    ];
    const host = setup('openai-codex', entries);
    host.fire('session_start');
    expect(host.fire('before_provider_request', {})).toEqual({ service_tier: 'priority' });
    host.ctx.model = { provider: 'anthropic' } as never;
    expect(host.fire('before_provider_request', { model: 'claude' })).toBeUndefined();
    host.ctx.model = { provider: 'openai-codex', api: 'openai-codex-responses' } as never;
    expect(host.fire('before_provider_request', {})).toEqual({ service_tier: 'priority' });
    entries.length = 0;
    host.fire('session_start');
    host.ctx.model = { provider: 'openai-codex', api: 'openai-codex-responses' } as never;
    expect(host.fire('before_provider_request', {})).toBeUndefined();
  });

  it('ignores copied parent or ownerless opt-in entries in a new session', () => {
    for (const data of [{ enabled: true }, { sessionId: 'parent', enabled: true }]) {
      const host = setup('openai-codex', [{ type: 'custom', customType: 'doompi.fast-mode', data }]);
      host.fire('session_start');
      expect(host.fire('before_provider_request', {})).toBeUndefined();
      const owned = setup('openai-codex', [
        { type: 'custom', customType: 'doompi.fast-mode', data: { sessionId: 'session-1', enabled: true } },
        { type: 'custom', customType: 'doompi.fast-mode', data },
      ]);
      owned.fire('session_start');
      expect(owned.fire('before_provider_request', {})).toEqual({ service_tier: 'priority' });
    }
  });

  it('requires the Codex API even for a provider named openai-codex', async () => {
    const host = setup();
    await host.run('on');
    host.ctx.model = { provider: 'openai-codex', api: 'openai-responses' } as never;
    expect(host.fire('before_provider_request', {})).toBeUndefined();
    await expect(host.run('on')).rejects.toThrow('openai-codex');
  });

  it('rejects non-Codex enabling and invalid command arguments never opt in', async () => {
    const host = setup('anthropic');
    await expect(host.run('on')).rejects.toThrow('openai-codex');
    await host.run('on extra');
    expect(host.appendEntry).not.toHaveBeenCalled();
    await host.run('off');
    expect(host.appendEntry).toHaveBeenCalledWith('doompi.fast-mode', {
      version: 1,
      sessionId: 'session-1',
      enabled: false,
    });
  });
});
