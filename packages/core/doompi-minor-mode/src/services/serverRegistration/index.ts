import type { Context } from '@deepseek-ai/cordis';
import {
  DOOM_HEADLESS_HOST_SERVICE,
  requireDoomHeadlessHost,
  readDoomHeadlessOwner,
} from '@agimon-ai/doompi-core/headless';
import type { DoomHeadlessMinorMode } from '../../schemas/headless';
import type { MinorModeOwner } from '../modeDefinition';
import { DOOM_MINOR_MODE_CATALOG_SERVICE, requireMinorModeCatalog } from '../../schemas/mode';

export function serverMinorModes(
  modes: readonly (DoomHeadlessMinorMode | MinorModeOwner<Parameters<DoomHeadlessMinorMode['handleAction']>[2]>)[],
): (context: Context) => void {
  return (context) => {
    context.inject([DOOM_HEADLESS_HOST_SERVICE, DOOM_MINOR_MODE_CATALOG_SERVICE], (child) => {
      const agent = requireDoomHeadlessHost(child);
      const owner = readDoomHeadlessOwner(child);
      if (!owner) throw new Error('A minor mode must have descriptor-owned package identity');
      const catalog = requireMinorModeCatalog(child);
      for (const mode of modes) {
        const definition = 'definition' in mode ? mode.definition : mode;
        const handle = catalog.registerOwner({
          ...definition,
          handleAction(id, args, execution) {
            agent.assertActive(owner.packageName);
            return definition.handleAction(id, args, { ...execution, context: agent.context });
          },
        });
        child.effect(() => () => handle.dispose());
        if ('definition' in mode) {
          child.effect(() => () => mode.detach());
          mode.attach(handle);
        }
      }
    });
  };
}
