import { definePiExtension } from '@agimon-ai/doompi-extension-contracts/pi-extension';
import { createAuthorCommand } from '../controllers/doomAuthorCommand';
import { createAuthorPiMode } from '../controllers/authorPiMode';
import { createAuthorTools } from '../tools/authorTools';
import { createAuthorCatalog } from '../services/authorCatalog';
import { AUTHOR_PACKAGE_SOURCE, AUTHOR_PI_GUIDANCE } from '../constants/author';
import type { AuthorExtensionDependencies } from '../types/extension';

const authorPiExtension = definePiExtension<Partial<AuthorExtensionDependencies>>(
  AUTHOR_PACKAGE_SOURCE,
  ({ options, signal }) => {
    const catalog = options?.catalog ?? createAuthorCatalog();
    const mode = createAuthorPiMode(catalog, signal);
    return {
      tools: createAuthorTools(catalog, mode.assertAvailable).map((tool) => ({
        ...tool,
        pi: { renderShell: 'self' as const },
      })),
      commands: [createAuthorCommand(options?.service)],
      minorModes: [mode.mode],
      toolRestrictions: [mode.restriction],
      resources: [
        {
          source: AUTHOR_PACKAGE_SOURCE,
          moduleUrl: import.meta.url,
          skills: [
            {
              name: 'doompi-use-author',
              description:
                'Use @agimon-ai/doompi-author: Visual steering workspace for focused document review and bounded authoring',
            },
          ],
        },
      ],
      events: {
        session_start: () => mode.mode.publish(),
        before_agent_start: (event) =>
          mode.isActive() ? { systemPrompt: `${event.systemPrompt}\n\n${AUTHOR_PI_GUIDANCE}` } : undefined,
      },
      onStart: mode.onStart,
      onStop: mode.onStop,
      onDispose: mode.onDispose,
    };
  },
);

export const installAuthorRuntime = authorPiExtension.install;
export const activateAuthorExtension = authorPiExtension;
export default activateAuthorExtension;
