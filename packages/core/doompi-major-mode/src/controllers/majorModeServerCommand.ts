import { loadMajorModesConfig, resolveLayers } from '@agimon-ai/doompi-config/majorModes';
import { type DoomHeadlessCommand, type DoomHeadlessHostService } from '@agimon-ai/doompi-core/headless';
import { MAJOR_MODE_COMMAND, majorModeOptionLabel } from '../services/majorModeText';

export function createMajorModeServerCommand(host: DoomHeadlessHostService): DoomHeadlessCommand {
  return {
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
}
