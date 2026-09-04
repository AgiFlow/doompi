import type { ModelContext, ModelContextTool, WebPluginRuntime } from '@agimon-ai/doompi-web-contracts';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AuthorBrowserMessage, AuthorHubMessage } from '../../src/types/webAuthor.ts';
import {
  applyAuthorHubMessage,
  authorBridgeView,
  dropAuthorViewportSession,
  focusAuthorViewport,
  startAuthorBrowserBridge,
} from '../../src/web/authorBrowserBridge.ts';

const releases: Array<() => void> = [];

afterEach(() => {
  while (releases.length > 0) releases.pop()?.();
  vi.useRealTimers();
});

function fixture() {
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
    sendSessionFrame() {},
    sendHubFrame(frame) {
      sent.push(frame.payload as unknown as AuthorBrowserMessage);
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

const accepted = (catalogToken?: string): AuthorHubMessage => ({
  kind: 'accepted',
  generation: 1,
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

    expect(h.sent).toEqual([{ kind: 'register', generation: 1 }]);
    applyAuthorHubMessage('session', accepted());
    expect(h.sent.at(-1)).toMatchObject({ kind: 'catalog', generation: 1, ownerToken: 'owner' });
    applyAuthorHubMessage('session', accepted('catalog'));
    expect(authorBridgeView('session')).toEqual({ activation: 'active', capabilityCount: 1 });

    applyAuthorHubMessage('session', {
      kind: 'request',
      generation: 1,
      ownerToken: 'wrong-owner',
      catalogToken: 'catalog',
      requestId: 'fenced',
      name: 'author_test',
      arguments: {},
    });
    expect(execute).not.toHaveBeenCalled();

    applyAuthorHubMessage('session', {
      kind: 'request',
      generation: 1,
      ownerToken: 'owner',
      catalogToken: 'catalog',
      requestId: 'request',
      name: 'author_test',
      arguments: { value: 1 },
    });
    await vi.waitFor(() => expect(h.sent.at(-1)).toMatchObject({ kind: 'result', requestId: 'request' }));
    expect(execute).toHaveBeenCalledWith({ value: 1 }, expect.any(AbortSignal));

    await vi.advanceTimersByTimeAsync(1_000);
    expect(h.sent.at(-1)).toEqual({ kind: 'register', generation: 1 });
    h.connected();
    expect(h.sent.at(-1)).toEqual({ kind: 'register', generation: 1 });
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
    applyAuthorHubMessage('session', accepted());
    applyAuthorHubMessage('session', accepted('catalog'));
    applyAuthorHubMessage('session', {
      kind: 'request',
      generation: 1,
      ownerToken: 'owner',
      catalogToken: 'catalog',
      requestId: 'request',
      name: 'author_wait',
      arguments: {},
    });
    applyAuthorHubMessage('session', {
      kind: 'cancel',
      generation: 1,
      ownerToken: 'owner',
      catalogToken: 'catalog',
      requestId: 'request',
    });
    await vi.waitFor(() => expect(h.sent.at(-1)).toMatchObject({ kind: 'cancelled', requestId: 'request' }));

    dropAuthorViewportSession('session');
    expect(h.sent.at(-1)).toEqual({ kind: 'release', generation: 1 });
    expect(authorBridgeView('session')).toEqual({ activation: 'inactive', capabilityCount: 0 });
    expect(h.tools.size).toBe(0);
  });
});
