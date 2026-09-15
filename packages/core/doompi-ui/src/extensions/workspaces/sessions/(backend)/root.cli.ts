import { defineRoot } from '@agimon-ai/doompi-core/extension-file';
import type { PiPluginContext } from '@agimon-ai/doompi-core/pi-extension';
import { DOOM_UI_HUB_SERVICE } from '@agimon-ai/doompi-core/ui-hub';
import {
  DOOM_MINOR_MODE_CATALOG_SERVICE,
  createMinorModeCatalogClient,
  requireMinorModeCatalog,
} from '@agimon-ai/doompi-minor-mode';

import { projectMinorModeRecords } from '../../../../models/uiState';
import { createUiTelemetry, type UiTelemetry } from '../../../../services/telemetry';
import { createBuiltinTools } from '../../../../tui/builtinTools';
import { createUiRuntime } from '../../../../tui/uiRuntime';
import type { UiPiScope } from './_lib/piScope';

export default defineRoot(({ context, pi, options, runtime }: PiPluginContext<UiTelemetry>) => {
  if (!runtime) throw new Error('This Pi extension requires the Cordis runtime metadata.');
  const ui = createUiRuntime(context, { pi, telemetry: options ?? createUiTelemetry() });
  const tools = createBuiltinTools(process.cwd());
  const service = (owner: PiPluginContext['context']) => {
    owner.provide(DOOM_UI_HUB_SERVICE, ui.hub);
    owner.inject([DOOM_MINOR_MODE_CATALOG_SERVICE], (modeContext) => {
      const catalog = createMinorModeCatalogClient(requireMinorModeCatalog(modeContext));
      const update = (): void => ui.uiState.setModes(projectMinorModeRecords(catalog.list()));
      const unsubscribe = catalog.subscribe(update);
      update();
      return () => {
        unsubscribe();
        ui.uiState.setModes([]);
      };
    });
  };
  return {
    value: { ui, tools, runtime } satisfies UiPiScope,
    services: [service],
    onStop: () => ui.dispose(),
    onDispose: () => ui.dispose(),
  };
});
