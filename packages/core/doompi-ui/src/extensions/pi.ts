import { definePiExtension } from '@agimon-ai/doompi-core/pi-extension';
import { DOOM_UI_HUB_SERVICE } from '@agimon-ai/doompi-core/ui-hub';
import {
  DOOM_MINOR_MODE_CATALOG_SERVICE,
  createMinorModeCatalogClient,
  requireMinorModeCatalog,
} from '@agimon-ai/doompi-minor-mode';
import { PACKAGE_SOURCE } from '../constants/ui';
import { projectMinorModeRecords } from '../models/uiState';
import { createUiTelemetry, type UiTelemetry } from '../services/telemetry';
import { createBuiltinTools } from '../tui/builtinTools';
import { createUiRuntime } from '../tui/uiRuntime';

export const doomPiUiExtension = definePiExtension<UiTelemetry>(PACKAGE_SOURCE, ({ context, pi, options, runtime }) => {
  if (!runtime) throw new Error('This Pi extension requires the Cordis runtime metadata.');
  const ui = createUiRuntime(context, { pi, telemetry: options ?? createUiTelemetry() });
  const tools = createBuiltinTools(process.cwd());
  return {
    services: [
      (owner) => {
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
      },
    ],
    commands: ui.commands,
    events: ui.events,
    tools: runtime.mode === 'composed' ? tools : [],
    toolOverrides:
      runtime.mode === 'composed'
        ? []
        : tools.map((tool) => ({
            source: PACKAGE_SOURCE,
            tools: [tool.name],
            replacements: [tool],
          })),
    onStop: () => ui.dispose(),
    onDispose: () => ui.dispose(),
  };
});

export default doomPiUiExtension;
