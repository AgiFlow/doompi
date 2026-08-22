import type { ExtensionAPI, ExtensionContext } from '@earendil-works/pi-coding-agent';
import { COMMAND_NAME } from '../schemas/mcpCommands.ts';
import type { McpCommandTarget } from '../types/mcp.ts';

interface McpCommandDeps {
  openOverlay(ctx: ExtensionContext): Promise<void>;
}

const COMMAND_DESCRIPTION = 'Browse this session MCP servers: authorize, enable, disable, tools and resources';
const INFO = 'info';
const WARNING = 'warning';

const SUBCOMMAND = { status: 'status', auth: 'auth', reload: 'reload' } as const;
const SUBCOMMANDS = Object.values(SUBCOMMAND).join(', ');

/** `/mcp <subcommand> [argument]`, with the bare command showing status. */
function parseArguments(args: string): { subcommand: string; argument: string } {
  const [subcommand = SUBCOMMAND.status, ...rest] = args.trim().split(/\s+/).filter(Boolean);
  return { subcommand, argument: rest.join(' ') };
}

/** One line per server: its state, and how many tools it currently offers. */
export function formatStatus(session: McpCommandTarget): string {
  const { servers } = session.getSnapshot();
  if (servers.length === 0) return 'No MCP servers are configured for this session.';
  const lines = servers.map((server) => {
    const detail = server.error ? ` (${server.error})` : '';
    return `${server.name}: ${server.state} · ${server.tools.length} tools${detail}`;
  });
  return [...lines, ...session.getDiagnostics()].join('\n');
}

async function runAuth(session: McpCommandTarget, serverName: string, ctx: ExtensionContext): Promise<void> {
  if (!serverName) {
    ctx.ui.notify('Name the server to authorize, for example /mcp auth boomlink.', WARNING);
    return;
  }
  try {
    // Reconnecting is what drives the flow: the OAuth provider surfaces the
    // authorization URL through the handler this extension installed.
    await session.reauthorize(serverName);
    ctx.ui.notify(`${serverName} is authorized.`, INFO);
  } catch (error) {
    ctx.ui.notify(
      `Could not authorize ${serverName}: ${error instanceof Error ? error.message : 'unknown error'}`,
      WARNING,
    );
  }
}

export function registerCommand(pi: ExtensionAPI, session: McpCommandTarget, deps: McpCommandDeps): void {
  pi.registerCommand(COMMAND_NAME, {
    description: COMMAND_DESCRIPTION,
    handler: async (args, ctx) => {
      const raw = typeof args === 'string' ? args : '';
      // The bare command opens the browser, where the same information can be acted
      // on. The subcommands stay because an overlay needs a terminal, and a headless
      // or scripted session still has to be able to ask.
      if (raw.trim() === '' && ctx.hasUI) {
        await deps.openOverlay(ctx);
        return;
      }
      const { subcommand, argument } = parseArguments(raw);
      if (subcommand === SUBCOMMAND.auth) {
        await runAuth(session, argument, ctx);
        return;
      }
      if (subcommand === SUBCOMMAND.reload) {
        ctx.ui.notify('Reconnecting MCP servers.', INFO);
        // Not awaited: a server that never answers must not wedge the command.
        void session.start();
        return;
      }
      if (subcommand !== SUBCOMMAND.status) {
        ctx.ui.notify(`Unknown /${COMMAND_NAME} subcommand "${subcommand}". Use ${SUBCOMMANDS}.`, WARNING);
        return;
      }
      ctx.ui.notify(formatStatus(session), INFO);
    },
  });
}
