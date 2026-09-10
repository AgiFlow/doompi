import { readFile } from 'node:fs/promises';
import {
  DOOM_HEADLESS_HOST_SERVICE,
  requireDoomHeadlessHost,
  type DoomHeadlessCommand,
  type DoomHeadlessResource,
} from '@agimon-ai/doompi-extension-contracts/headless';
import type { Context } from '@deepseek-ai/cordis';
import { MAJOR_MODE_COMMAND } from '../../services/majorModeText.ts';

const PACKAGE_ROOT = new URL('../../../', import.meta.url);

function modeMetadata(execution: {
  readonly selection: { readonly majorMode: string; readonly activeLayers: readonly string[] };
}): string {
  return JSON.stringify({
    majorMode: execution.selection.majorMode,
    activeLayers: execution.selection.activeLayers,
  });
}

async function readOrFallback(filePath: string, fallback: string): Promise<string> {
  try {
    return await readFile(filePath, 'utf8');
  } catch {
    return fallback;
  }
}

export const majorModeHeadlessFacet = {
  inject: [DOOM_HEADLESS_HOST_SERVICE],
  apply(context: Context) {
    const host = requireDoomHeadlessHost(context);
    const resources: DoomHeadlessResource[] = [
      {
        name: 'doompi/modes-config',
        kind: 'context',
        read: (execution) => modeMetadata(execution),
      },
      {
        name: 'doompi/model',
        kind: 'context',
        read: (execution) => JSON.stringify(execution.model ?? null),
      },
      {
        name: 'doompi-author-major-mode',
        kind: 'skill',
        read: () =>
          readOrFallback(
            new URL('src/prompts/doompi-author-major-mode/SKILL.md', PACKAGE_ROOT).pathname,
            '(resource unavailable)',
          ),
      },
    ];
    const command: DoomHeadlessCommand = {
      name: MAJOR_MODE_COMMAND,
      description: 'Show or change the active DoomPi major mode.',
      async execute(args, execution) {
        const requested = args.trim();
        if (!requested) {
          await execution.client.notify({
            title: 'DoomPi major mode',
            body: `Active major mode: ${execution.selection.majorMode}\nActive layers: ${execution.selection.activeLayers.join(', ') || '(none)'}`,
            level: 'info',
          });
          return;
        }
        await host.select({ majorMode: requested });
      },
    };
    const registrations = [
      ...resources.map((resource) => host.registerResource(resource)),
      host.registerCommand(command),
    ];
    return () => {
      for (const registration of registrations) registration.dispose();
    };
  },
};
