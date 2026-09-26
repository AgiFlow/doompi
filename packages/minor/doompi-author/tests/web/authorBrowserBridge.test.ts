import type { ModelContext, ModelContextTool, WebPluginRuntime } from '@agimon-ai/doompi-core/web';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  applyAuthorHubMessage,
  authorBridgeView,
  dropAuthorViewportSession,
  focusAuthorViewport,
  openAuthorCanvas,
  startAuthorBrowserBridge,
} from '../../src/extensions/workspaces/sessions/(frontend)/_lib/authorBrowserBridge';
import type { AuthorBrowserMessage, AuthorHubMessage } from '../../src/types/webAuthor';

const releases: Array<() => void> = [];

afterEach(() => {
  while (releases.length > 0) releases.pop()?.();
  vi.useRealTimers();
});

function fixture(sessionId = 'session') {
  const tools = new Map<string, ModelContextTool>();
  const sent: AuthorBrowserMessage[] = [];
  let connected: (() => void) | undefined;
  const modelContext: ModelContext = {
    registerTool(tool, options) {
      tools.set(tool.name, tool);
      options.signal.addEventListener('abort', () => {
        if (tools.get(tool.name) === tool) tools.delete(tool.name);
      });
    },
    async getTools() {
      return [...tools.values()];
    },
    async executeTool(name, input, options) {
      const tool = tools.get(name);
      if (tool === undefined) throw new Error('missing tool');
      return tool.execute(input, options);
    },
    addEventListener() {},
    removeEventListener() {},
  };
  const runtime: WebPluginRuntime = {
    mount: { scope: 'session', workspaceId: 'work-1', sessionId },
    sendSessionFrame() {},
    sendHubFrame() {},
    async invokeServerMethod(call) {
      sent.push((call.input as { message: AuthorBrowserMessage }).message);
      return {};
    },
    onHubConnected(listener) {
      connected = listener;
      return () => {
        connected = undefined;
      };
    },
    acquireModelContext: async () => ({ kind: 'simulator', modelContext }),
  };
  return { connected: () => connected?.(), runtime, sent, tools };
}

const accepted = (generation: number, catalogToken?: string, alias = 'default'): AuthorHubMessage => ({
  kind: 'accepted',
  alias,
  generation,
  ownerToken: 'owner',
  leaseMs: 2_000,
  ...(catalogToken === undefined ? {} : { catalogToken }),
});

describe('Author browser bridge', () => {
  it('registers, confirms, renews, executes, and fences a viewport catalog', async () => {
    vi.useFakeTimers();
    const h = fixture();
    releases.push(startAuthorBrowserBridge(h.runtime));
    const execute = vi.fn(async (input: unknown) => ({ input }));
    releases.push(
      await focusAuthorViewport('session', [
        {
          id: 'profile',
          tools: [{ name: 'author_test', description: 'test', inputSchema: {}, execute }],
        },
      ]),
    );

    expect(h.sent.at(-1)).toMatchObject({ kind: 'register', alias: 'default' });
    const generation = h.sent.at(-1)!.generation;
    applyAuthorHubMessage('session', accepted(generation));
    expect(h.sent.at(-1)).toMatchObject({ kind: 'catalog', generation, ownerToken: 'owner' });
    applyAuthorHubMessage('session', accepted(generation, 'catalog'));
    expect(authorBridgeView('session')).toEqual({ activation: 'active', capabilityCount: 1 });

    applyAuthorHubMessage('session', {
      kind: 'request',
      alias: 'default',
      generation,
      ownerToken: 'wrong-owner',
      catalogToken: 'catalog',
      requestId: 'fenced',
      name: 'author_test',
      arguments: {},
    });
    expect(execute).not.toHaveBeenCalled();

    applyAuthorHubMessage('session', {
      kind: 'request',
      alias: 'default',
      generation,
      ownerToken: 'owner',
      catalogToken: 'catalog',
      requestId: 'request',
      name: 'author_test',
      arguments: { value: 1 },
    });
    await vi.waitFor(() => expect(h.sent.at(-1)).toMatchObject({ kind: 'result', requestId: 'request' }));
    expect(execute).toHaveBeenCalledWith({ value: 1 }, expect.any(AbortSignal));

    await vi.advanceTimersByTimeAsync(1_000);
    expect(h.sent.at(-1)).toEqual({ kind: 'register', alias: 'default', generation });
    h.connected();
    expect(h.sent.at(-1)).toEqual({ kind: 'register', alias: 'default', generation });
  });

  it('returns structured tool failures instead of reporting cancellation', async () => {
    const h = fixture();
    releases.push(startAuthorBrowserBridge(h.runtime));
    await focusAuthorViewport('session', [
      {
        id: 'profile',
        tools: [
          {
            name: 'author_fail',
            description: 'fail',
            inputSchema: {},
            execute: async () => {
              throw new Error('STALE_GRID: Describe the grid again.');
            },
          },
        ],
      },
    ]);
    const generation = h.sent.at(-1)!.generation;
    applyAuthorHubMessage('session', accepted(generation));
    applyAuthorHubMessage('session', accepted(generation, 'catalog'));
    applyAuthorHubMessage('session', {
      kind: 'request',
      alias: 'default',
      generation,
      ownerToken: 'owner',
      catalogToken: 'catalog',
      requestId: 'failed',
      name: 'author_fail',
      arguments: {},
    });

    await vi.waitFor(() =>
      expect(h.sent.at(-1)).toMatchObject({
        kind: 'result',
        requestId: 'failed',
        result: { error: { code: 'STALE_GRID', message: 'STALE_GRID: Describe the grid again.' } },
      }),
    );
  });
  it('keeps two named catalogs registered while their viewport is hidden and isolates close', async () => {
    const h = fixture();
    releases.push(startAuthorBrowserBridge(h.runtime));
    const executeA = vi.fn(async () => 'a');
    const executeB = vi.fn(async () => 'b');
    const profile = (execute: typeof executeA) => [
      {
        id: 'profile',
        tools: [
          { name: 'author_test', description: 'test', inputSchema: {}, execute },
          { name: 'author_describe_grid', description: 'grid', inputSchema: {}, execute },
        ],
      },
    ];
    await openAuthorCanvas('session', 'a', profile(executeA));
    await openAuthorCanvas('session', 'b', profile(executeB));
    expect(h.tools.size).toBe(2);
    expect([...h.tools.keys()].every((name) => name !== 'author_test')).toBe(true);
    const registrations = h.sent.filter((message) => message.kind === 'register');
    expect(registrations.map((message) => message.alias)).toEqual(['a', 'b']);
    for (const registration of registrations) {
      const alias = registration.alias;
      applyAuthorHubMessage('session', accepted(registration.generation, undefined, alias));
      applyAuthorHubMessage('session', accepted(registration.generation, `token-${alias}`, alias));
    }
    const first = registrations[0]!;
    applyAuthorHubMessage('session', {
      kind: 'request',
      alias: 'a',
      generation: first.generation,
      ownerToken: 'owner',
      catalogToken: 'token-b',
      requestId: 'cross',
      name: 'author_test',
      arguments: {},
    });
    expect(executeA).not.toHaveBeenCalled();
    applyAuthorHubMessage('session', {
      kind: 'request',
      alias: 'a',
      generation: first.generation,
      ownerToken: 'owner',
      catalogToken: 'token-a',
      requestId: 'a-request',
      name: 'author_test',
      arguments: {},
    });
    await vi.waitFor(() => expect(executeA).toHaveBeenCalledOnce());
    dropAuthorViewportSession('session', 'a');
    expect(h.tools.size).toBe(1);
    const second = registrations[1]!;
    applyAuthorHubMessage('session', {
      kind: 'request',
      alias: 'b',
      generation: second.generation,
      ownerToken: 'owner',
      catalogToken: 'token-b',
      requestId: 'b-request',
      name: 'author_test',
      arguments: {},
    });
    await vi.waitFor(() => expect(executeB).toHaveBeenCalledOnce());
  });
  it('starting another session mount does not discard a conversation catalog', async () => {
    const first = fixture('session');
    releases.push(startAuthorBrowserBridge(first.runtime));
    await openAuthorCanvas('session', 'alpha', [
      {
        id: 'profile',
        tools: [{ name: 'author_test', description: 'test', inputSchema: {}, execute: async () => 'a' }],
      },
    ]);
    const second = fixture('other');
    releases.push(startAuthorBrowserBridge(second.runtime));
    await openAuthorCanvas('other', 'beta', [
      {
        id: 'profile',
        tools: [{ name: 'author_test', description: 'test', inputSchema: {}, execute: async () => 'b' }],
      },
    ]);
    expect(first.tools.size).toBe(1);
    expect(second.tools.size).toBe(1);
    dropAuthorViewportSession('other');
    expect(first.tools.size).toBe(1);
    expect(second.tools.size).toBe(0);
  });
  it('cancels pending work and drops the active session cleanly', async () => {
    const h = fixture();
    releases.push(startAuthorBrowserBridge(h.runtime));
    const execute = vi.fn(
      (_input: unknown, signal: AbortSignal) =>
        new Promise((_resolve, reject) =>
          signal.addEventListener('abort', () => reject(signal.reason), { once: true }),
        ),
    );
    await focusAuthorViewport('session', [
      { id: 'profile', tools: [{ name: 'author_wait', description: 'wait', inputSchema: {}, execute }] },
    ]);
    const generation = h.sent.at(-1)!.generation;
    applyAuthorHubMessage('session', accepted(generation));
    applyAuthorHubMessage('session', accepted(generation, 'catalog'));
    applyAuthorHubMessage('session', {
      kind: 'request',
      alias: 'default',
      generation,
      ownerToken: 'owner',
      catalogToken: 'catalog',
      requestId: 'request',
      name: 'author_wait',
      arguments: {},
    });
    applyAuthorHubMessage('session', {
      kind: 'cancel',
      alias: 'default',
      generation,
      ownerToken: 'owner',
      catalogToken: 'catalog',
      requestId: 'request',
    });
    await vi.waitFor(() => expect(h.sent.at(-1)).toMatchObject({ kind: 'cancelled', requestId: 'request' }));

    dropAuthorViewportSession('session');
    expect(h.sent.at(-1)).toEqual({ kind: 'release', alias: 'default', generation });
    expect(authorBridgeView('session')).toEqual({ activation: 'inactive', capabilityCount: 0 });
    expect(h.tools.size).toBe(0);
  });
});
