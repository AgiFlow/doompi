import type { DoomExtensionContext } from '@agimon-ai/doompi-core/runtime-config';
import type { MinorModeCatalogService, MinorModeOwnerDefinition, MinorModeOwnerHandle } from '../../schemas/mode';

/** Register an owner directly with the injected session catalog. */
export function registerMinorModeOwner<ExtensionContext extends DoomExtensionContext>(
  catalog: MinorModeCatalogService,
  definition: MinorModeOwnerDefinition<ExtensionContext>,
): MinorModeOwnerHandle {
  return catalog.registerOwner(definition);
}
