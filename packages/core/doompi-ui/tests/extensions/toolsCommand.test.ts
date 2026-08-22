import { connectDoomCordisHost } from '@agimon-ai/doompi-extension-contracts/cordis-host';
import { DOOM_MCP_STATUS_SERVICE, type McpStatusSnapshot } from '@agimon-ai/doompi-extension-contracts/mcp-status';
import type { EventBusLike } from '@agimon-ai/doompi-extension-contracts/protocol';
import type { ExtensionAPI, ExtensionContext, ToolInfo } from '@earendil-works/pi-coding-agent';
import { describe, expect, it, vi } from 'vitest';
import doomPiUiExtension from '../../src/exports/extensions/pi.ts';
import type { UiTelemetry } from '../../src/exports/logSinkTelemetry.ts';

type CommandHandler = (args: string, ctx: ExtensionContext) => Promise<void>;

const MCP_EXTENSION_PATH = '/repo/.pi/doom/mcp-extension.ts';
const SESSION_ID = 'session-1';

/** Working in-memory bus: the status query is a real request/reply round trip. */
class TestBus implements EventBusLike {
  private readonly handlers = new Map<string, Set<(data: unknown) => void>>();

  emit(event: string, data: unknown): void {
    for (const handler of this.handlers.get(event) ?? []) handler(data);
  }

  on(event: string, handler: (data: unknown) => void): () => void {
    const handlers = this.handlers.get(event) ?? new Set();
    handlers.add(handler);
    this.handlers.set(event, handlers);
    return () => handlers.delete(handler);
  }
}

function telemetry(): UiTelemetry {
  return {
    recordError: vi.fn(async () => undefined),
    recordWarning: vi.fn(async () => undefined),
    recordEvent: vi.fn(async () => undefined),
    flush: vi.fn(async () => undefined),
    shutdown: vi.fn(async () => undefined),
  };
}

function tool(name: string, source: string, path = `<${source}>`): ToolInfo {
  return {
    name,
    description: `${name} description`,
    sourceInfo: { path, source, scope: 'project', origin: 'top-level' },
  } as ToolInfo;
}

/** A session context that skips the TUI surfaces the tools panel does not need. */
function headlessContext(): ExtensionContext {
  return {
    mode: 'headless',
    cwd: '/repo/agirepo',
    sessionManager: { getEntries: () => [], getSessionId: () => SESSION_ID },
    ui: { custom: vi.fn(), notify: vi.fn(), setWidget: vi.fn() },
  } as unknown as ExtensionContext;
}

async function register(tools: readonly ToolInfo[]) {
  const bus = new TestBus();
  const commands = new Map<string, CommandHandler>();
  const sessionHandlers = new Map<string, Array<(event: unknown, ctx: ExtensionContext) => void | Promise<void>>>();
  const pi = {
    events: bus,
    getCommands: vi.fn(() => []),
    getAllTools: vi.fn(() => [...tools]),
    getActiveTools: vi.fn(() => ['read']),
    registerTool: vi.fn(),
    registerCommand: vi.fn((name: string, options: { handler: CommandHandler }) => {
      commands.set(name, options.handler);
    }),
    on: vi.fn((event: string, handler: (payload: unknown, ctx: ExtensionContext) => void) => {
      sessionHandlers.set(event, [...(sessionHandlers.get(event) ?? []), handler]);
    }),
  } as unknown as ExtensionAPI;
  await doomPiUiExtension(pi, telemetry());
  const connection = await connectDoomCordisHost(pi, '@agimon-ai/doompi-ui/tools-test');

  const fire = async (event: string): Promise<void> => {
    for (const handler of sessionHandlers.get(event) ?? []) await handler({}, headlessContext());
  };

  return {
    bus,
    commands,
    startSession: () => fire('session_start'),
    shutdownSession: () => fire('session_shutdown'),
    /** Stands in for doom-mcp, publishing status from its own Cordis fiber. */
    provideStatus: async (respond: () => McpStatusSnapshot) => {
      const fiber = connection.root.plugin((context) =>
        context.provide(DOOM_MCP_STATUS_SERVICE, {
          generation: 'mcp-test-generation',
          getSnapshot: respond,
        }),
      );
      await fiber.await();
      return fiber;
    },
  };
}

/** Captures the overlay the command opens, without a terminal behind it. */
function createContext() {
  const custom = vi.fn(async () => undefined);
  const context = {
    mode: 'tui',
    cwd: '/repo/agirepo',
    sessionManager: { getEntries: () => [], getSessionId: () => SESSION_ID },
    ui: { custom, notify: vi.fn(), setWidget: vi.fn() },
  } as unknown as ExtensionContext;
  return { context, custom };
}

function renderOverlay(custom: ReturnType<typeof vi.fn>): string {
  const factory = custom.mock.calls[0]?.[0] as (
    tui: unknown,
    theme: unknown,
    keybindings: unknown,
    done: (result: undefined) => void,
  ) => { render(width: number): string[] };
  const theme = {
    fg: (_color: string, text: string) => text,
    bg: (_color: string, text: string) => text,
    bold: (text: string) => text,
    inverse: (text: string) => text,
  };
  const component = factory({ terminal: { rows: 20 }, requestRender: vi.fn() }, theme, undefined, vi.fn());
  return component.render(100).join('\n');
}

describe('doom-pi-ui tools command', () => {
  it('groups mcp tools by the server the status query attributes them to', async () => {
    const extension = await register([
      tool('read', 'builtin', '<builtin:read>'),
      tool('mcp__code_intel_get_diagnostics', 'mcp-extension', MCP_EXTENSION_PATH),
    ]);
    await extension.startSession();
    await extension.provideStatus(() => ({
      servers: [
        {
          name: 'code-intel',
          state: 'connected',
          tools: ['mcp__code_intel_get_diagnostics'],
          resourceCount: 0,
        },
      ],
    }));

    const { context, custom } = createContext();
    await extension.commands.get('tools')?.('', context);

    expect(custom).toHaveBeenCalledOnce();
    const rendered = renderOverlay(custom);
    expect(rendered).toContain('pi · core');
    expect(rendered).toContain('code-intel · mcp');
    // Only `read` of the two registered tools is in the active set.
    expect(rendered).toContain('1/2 tools · 2 sources');
  });

  it('reports a server state that explains an empty tool list', async () => {
    const extension = await register([tool('read', 'builtin', '<builtin:read>')]);
    await extension.startSession();
    await extension.provideStatus(() => ({
      servers: [{ name: 'boomlink', state: 'needs-auth', tools: [], resourceCount: 0 }],
    }));

    const { context, custom } = createContext();
    await extension.commands.get('tools')?.('', context);

    expect(renderOverlay(custom)).toContain('needs auth');
  });

  // `--no-mcp` leaves nobody answering. The panel still has to open.
  it('opens on the extension grouping when nothing answers the status query', async () => {
    const extension = await register([tool('mcp__code_intel_get_diagnostics', 'mcp-extension', MCP_EXTENSION_PATH)]);
    await extension.startSession();

    const { context, custom } = createContext();
    await extension.commands.get('tools')?.('', context);

    const rendered = renderOverlay(custom);
    expect(rendered).toContain('mcp-extension');
    expect(rendered).not.toContain(' · mcp');
  });

  it('returns to extension grouping when the provider fiber disappears', async () => {
    const extension = await register([tool('mcp__code_intel_get_diagnostics', 'mcp-extension', MCP_EXTENSION_PATH)]);
    await extension.startSession();
    const provider = await extension.provideStatus(() => ({ servers: [] }));
    await provider.dispose();

    const { context, custom } = createContext();
    await extension.commands.get('tools')?.('', context);

    expect(renderOverlay(custom)).not.toContain(' · mcp');
  });
});
