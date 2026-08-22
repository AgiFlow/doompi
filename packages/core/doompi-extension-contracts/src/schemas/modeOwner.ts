import type { DoomExtensionContext } from './config.ts';
import type { MinorModeCatalogService, MinorModeOwnerDefinition, MinorModeOwnerHandle } from './mode.ts';

/** Register an owner directly with the injected session catalog. */
export function registerMinorModeOwner<ExtensionContext extends DoomExtensionContext>(
  catalog: MinorModeCatalogService,
  definition: MinorModeOwnerDefinition<ExtensionContext>,
): MinorModeOwnerHandle {
  return catalog.registerOwner(definition);
}
