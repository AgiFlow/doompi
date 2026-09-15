import type { DoomServerPluginDefinition } from '@agimon-ai/doompi-core/server-facet';
import { serverMinorModes } from '@agimon-ai/doompi-minor-mode';

import { AUTHOR_FACADE_TOOL_NAMES, AUTHOR_GUIDANCE } from '../../../../constants/author';
import { api, createAuthorSessionApi } from '../../../../controllers/authorApi';
import { createAuthorCommand } from '../../../../controllers/doomAuthorCommand';
import { authorMinorMode } from '../../../../models/authorMode';
import { createAuthorCatalog } from '../../../../services/authorCatalog';
import { readAuthorPrompt } from '../../../../services/authorPrompt';
import { createAuthorTools } from '../../../../tools/authorTools';
import { OPEN_AUTHORING_FILE_TOOL_NAME } from '../../../../types/author';

export default (({ agent }) => {
  const session = agent ? createAuthorSessionApi(agent.context.cwd, agent.context.sessionId) : undefined;
  return {
    api: [session?.api ?? api],
    ...(agent
      ? {
          services: [
            serverMinorModes([
              authorMinorMode.createOwner({
                isActive: () =>
                  (agent.context.selection.state?.['minor-mode'] ?? []).includes(authorMinorMode.descriptor.id),
                detail: () => 'document authoring available',
                async setActive(enabled) {
                  const modes = (agent.context.selection.state?.['minor-mode'] ?? []).filter(
                    (id) => id !== authorMinorMode.descriptor.id,
                  );
                  await agent.changeSelection({
                    axis: 'state',
                    key: 'minor-mode',
                    values: enabled ? [...modes, authorMinorMode.descriptor.id] : modes,
                  });
                },
              }),
            ]),
          ],
        }
      : {}),
    toolRestrictions: [
      {
        when: { state: { 'minor-mode': 'author' } },
        allowedTools: [OPEN_AUTHORING_FILE_TOOL_NAME, ...AUTHOR_FACADE_TOOL_NAMES],
      },
    ],
    resources: [
      {
        when: { state: { 'minor-mode': 'author' }, attribution: { kind: 'minor', mode: 'author' } },
        name: 'doompi-use-author',
        kind: 'skill',
        read: () => readAuthorPrompt(),
      },
    ],
    tools: createAuthorTools(createAuthorCatalog(session?.catalog)).map((tool) => ({
      ...tool,
      when: { state: { 'minor-mode': 'author' }, attribution: { kind: 'minor', mode: 'author' } },
    })),
    commands: [createAuthorCommand()],
    hooks: [
      {
        when: { state: { 'minor-mode': 'author' }, attribution: { kind: 'minor', mode: 'author' } },
        event: 'before_agent_start',
        handle(event) {
          const systemPrompt = typeof event.systemPrompt === 'string' ? event.systemPrompt : '';
          return { systemPrompt: `${systemPrompt}\n\n${AUTHOR_GUIDANCE}`.trim() };
        },
      },
    ],
  };
}) satisfies NonNullable<DoomServerPluginDefinition['session']>;
