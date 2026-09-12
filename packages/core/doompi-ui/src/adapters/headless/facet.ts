import {
  DOOM_HEADLESS_HOST_SERVICE,
  requireDoomHeadlessHost,
  type DoomHeadlessCommand,
  type DoomHeadlessResource,
} from '@agimon-ai/doompi-extension-contracts/headless';
import type { Context } from '@deepseek-ai/cordis';

const TOOL_COMMAND = 'tools';

function toolNames(entries: readonly Record<string, unknown>[]): string[] {
  const names = new Set<string>();
  for (const entry of entries) {
    const message = entry.message;
    if (!message || typeof message !== 'object' || Array.isArray(message)) continue;
    const content = (message as { content?: unknown }).content;
    if (!Array.isArray(content)) continue;
    for (const block of content) {
      if (!block || typeof block !== 'object' || Array.isArray(block)) continue;
      const name = (block as { name?: unknown }).name;
      if (typeof name === 'string' && name) names.add(name);
    }
  }
  return [...names].sort();
}

/**
 * The TUI shell itself stays Pi-only. Inventory is the shared part and is exposed
 * from session data rather than silently installing a fake editor/widget host.
 */
export const uiHeadlessFacet = {
  inject: [DOOM_HEADLESS_HOST_SERVICE],
  apply(context: Context) {
    const host = requireDoomHeadlessHost(context);
    const inventory: DoomHeadlessResource = {
      name: 'doompi/tool-inventory',
      kind: 'context',
      read: async (execution) => {
        const names = toolNames(await execution.session.entries({ type: 'message' }));
        return names.length > 0 ? names.join('\n') : '(no tool calls recorded in this session)';
      },
    };
    const command: DoomHeadlessCommand = {
      name: TOOL_COMMAND,
      description: 'Show tools observed in this headless session. TUI rendering remains unavailable.',
      async execute(_args, execution) {
        await execution.client.notify({
          title: 'DoomPi tools',
          body:
            toolNames(await execution.session.entries({ type: 'message' })).join('\n') ||
            '(no tool calls recorded in this session)',
          level: 'info',
        });
      },
    };
    const registrations = [host.registerResource(inventory), host.registerCommand(command)];
    return () => {
      for (const registration of registrations) registration.dispose();
    };
  },
};
