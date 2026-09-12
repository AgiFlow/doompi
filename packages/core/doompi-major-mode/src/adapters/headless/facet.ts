import { readFile } from 'node:fs/promises';
import { loadMajorModesConfig, resolveLayers } from '@agimon-ai/doompi-config/majorModes';
import {
  DOOM_HEADLESS_HOST_SERVICE,
  requireDoomHeadlessHost,
  type DoomHeadlessCommand,
  type DoomHeadlessResource,
} from '@agimon-ai/doompi-extension-contracts/headless';
import type { Context } from '@deepseek-ai/cordis';
import { MAJOR_MODE_COMMAND, majorModeOptionLabel } from '../../services/majorModeText.ts';

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
        const config = loadMajorModesConfig(execution.repoRoot);
        let requested = args.trim();
        if (!requested) {
          const selected = await execution.client.request({
            kind: 'select',
            title: `Major mode (current: ${execution.selection.majorMode})`,
            options: Object.keys(config.majorMode).map((name) => ({
              label: majorModeOptionLabel(name, config.majorMode[name]?.layers ?? [], execution.selection.majorMode),
              value: name,
            })),
          });
          if (typeof selected !== 'string' || !selected) return;
          requested = selected;
        }
        // Reject invalid command input before requesting a capability transition.
        resolveLayers(config, requested);
        if (requested === execution.selection.majorMode) return;
        await host.changeSelection({ axis: 'majorMode', majorMode: requested });
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
