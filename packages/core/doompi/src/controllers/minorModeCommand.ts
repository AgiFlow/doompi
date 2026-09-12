import type { MinorModeCatalogService, MinorModeSessionKind } from '@agimon-ai/doompi-extension-contracts/mode';
import type { ExtensionAPI, ExtensionContext } from '@earendil-works/pi-coding-agent';
import {
  executeMinorModeCommand,
  MINOR_MODE_COMMAND,
  MINOR_MODE_COMMAND_DESCRIPTION,
} from '../services/minorModeCommand';

export { actionsFor, matchMinorMode, MINOR_MODE_COMMAND } from '../services/minorModeCommand';

function sessionKindOf(ctx: ExtensionContext): MinorModeSessionKind {
  return ctx.hasUI && ctx.mode === 'tui' ? 'tui' : 'headless';
}

/** Register the Pi prompt adapter for the shared minor-mode command behavior. */
export function registerMinorModeCommand(
  pi: ExtensionAPI,
  currentCatalog: () => MinorModeCatalogService | undefined,
): void {
  pi.registerCommand(MINOR_MODE_COMMAND, {
    description: MINOR_MODE_COMMAND_DESCRIPTION,
    getArgumentCompletions: (prefix) => {
      const query = prefix.trim().toLowerCase();
      const records = currentCatalog()?.list() ?? [];
      return records
        .map((record) => record.descriptor.label.toLowerCase())
        .filter((label) => label.startsWith(query))
        .map((label) => ({ value: label, label }));
    },
    handler: (args, ctx) =>
      executeMinorModeCommand(args, {
        catalog: currentCatalog(),
        kind: sessionKindOf(ctx),
        ui: {
          select: (title, options) => ctx.ui.select(title, [...options]),
          input: (title, message) => ctx.ui.input(title, message),
          confirm: (title, message) => ctx.ui.confirm(title, message),
          notify: (message, level) => ctx.ui.notify(message, level),
        },
      }),
  });
}
