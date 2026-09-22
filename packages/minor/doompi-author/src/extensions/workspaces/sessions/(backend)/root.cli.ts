import { defineRoot } from '@agimon-ai/doompi-core/extensionFile';
import { DOOM_HELP_SERVICE, requireDoomHelpService } from '@agimon-ai/doompi-core/help';
import type { PiPluginContext } from '@agimon-ai/doompi-core/piExtension';
import { DOOM_TOOL_SURFACE_SERVICE, requireDoomToolSurface } from '@agimon-ai/doompi-core/toolSurface';
import { piMinorModes } from '@agimon-ai/doompi-minor-mode';
import type { Context } from '@deepseek-ai/cordis';

import { AUTHOR_PACKAGE_SOURCE } from '../../../../constants/author';
import { createAuthorCatalog } from '../../../../services/authorCatalog';
import type { AuthorExtensionDependencies } from '../../../../types/extension';
import { createAuthorPiMode } from './_lib/authorPiMode';

export default defineRoot((context: PiPluginContext<Partial<AuthorExtensionDependencies>>) => {
  const catalog = context.options?.catalog ?? createAuthorCatalog();
  const mode = createAuthorPiMode(catalog, context.signal);
  const registrations = (cordis: Context): void => {
    cordis.inject([DOOM_HELP_SERVICE], (child) => {
      const handle = requireDoomHelpService(child).register({
        source: AUTHOR_PACKAGE_SOURCE,
        moduleUrl: import.meta.url,
        skills: [
          {
            name: 'doompi-use-author',
            description:
              'Use @agimon-ai/doompi-author: Visual steering workspace for focused document review and bounded authoring',
          },
        ],
      });
      child.effect(() => () => handle.dispose());
    });
    cordis.inject([DOOM_TOOL_SURFACE_SERVICE], (child) => {
      const surface = requireDoomToolSurface(child);
      const handle = surface.register(mode.restriction);
      child.effect(() => () => handle.dispose());
      child.effect(() =>
        mode.restriction.subscribe
          ? mode.restriction.subscribe(() => handle.update(mode.restriction.restrict))
          : () => undefined,
      );
    });
  };

  return {
    value: {
      catalog,
      assertAvailable: mode.assertAvailable,
      mode,
      service: context.options?.service,
    },
    services: [piMinorModes([mode.mode]), registrations],
    onStart: mode.onStart,
    onStop: mode.onStop,
    onDispose: mode.onDispose,
  };
});
