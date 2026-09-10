import { readFile } from 'node:fs/promises';
import {
  DOOM_HEADLESS_HOST_SERVICE,
  requireDoomHeadlessHost,
  type DoomHeadlessHook,
  type DoomHeadlessResource,
} from '@agimon-ai/doompi-extension-contracts/headless';
import type { Context } from '@deepseek-ai/cordis';

const PACKAGE_ROOT = new URL('../../../', import.meta.url);

async function readOrFallback(filePath: string, fallback: string): Promise<string> {
  try {
    return await readFile(filePath, 'utf8');
  } catch {
    return fallback;
  }
}

function hookEntry(event: Readonly<Record<string, unknown>>): Record<string, unknown> {
  return {
    version: 1,
    event: typeof event.type === 'string' ? event.type : 'headless-hook',
    data: event,
  };
}

export const hookHeadlessFacet = {
  inject: [DOOM_HEADLESS_HOST_SERVICE],
  apply(context: Context) {
    const host = requireDoomHeadlessHost(context);
    const resource: DoomHeadlessResource = {
      name: 'doompi-author-hook',
      kind: 'skill',
      read: () =>
        readOrFallback(
          new URL('src/prompts/doompi-author-hook/SKILL.md', PACKAGE_ROOT).pathname,
          '(resource unavailable)',
        ),
    };
    const hooks: DoomHeadlessHook[] = [
      {
        event: 'before_agent_start',
        handle: (event, execution) => execution.session.appendCustomEntry('doom-hook', hookEntry(event)),
      },
      {
        event: 'tool_result',
        handle: (event, execution) => execution.session.appendCustomEntry('doom-hook', hookEntry(event)),
      },
      {
        event: 'agent_settled',
        handle: (event, execution) => execution.session.appendCustomEntry('doom-hook', hookEntry(event)),
      },
      {
        event: 'session_shutdown',
        handle(_event, execution) {
          execution.client.setStatus('doom-hook', undefined);
        },
      },
    ];
    const registrations = [host.registerResource(resource), ...hooks.map((hook) => host.registerHook(hook))];
    return () => {
      for (const registration of registrations) registration.dispose();
    };
  },
};
