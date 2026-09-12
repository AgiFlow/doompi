import { defineServerPlugin } from '@agimon-ai/doompi-extension-contracts/server-facet';
import { AUTHOR_PACKAGE_SOURCE, AUTHOR_FACADE_TOOL_NAMES, AUTHOR_GUIDANCE } from '../constants/author';
import { createAuthorChannel } from '../controllers/webAuthorChannel';
import { createAuthorBridgeMethod } from '../controllers/authorBridgeMethod';
import { createAuthorCommand } from '../controllers/doomAuthorCommand';
import { api } from '../controllers/authorApi';
import { createAuthorCatalog } from '../services/authorCatalog';
import { readAuthorPrompt } from '../services/authorPrompt';
import { createAuthorTools } from '../tools/authorTools';
import { OPEN_AUTHORING_FILE_TOOL_NAME } from '../types/author';
import { authorMinorMode } from '../models/authorMode';

export const authorServerFacet = defineServerPlugin({
  name: AUTHOR_PACKAGE_SOURCE,
  global: ({ host }) => ({
    channels: [createAuthorChannel],
    methods: [createAuthorBridgeMethod('global', host)],
  }),
  workspace: ({ host }) => ({
    channels: [createAuthorChannel],
    methods: [createAuthorBridgeMethod('workspace', host)],
  }),
  session: ({ agent }) => ({
    api: [api],
    ...(agent
      ? {
          minorModes: [
            authorMinorMode.createOwner({
              isActive: () => agent.context.selection.minorModes.includes(authorMinorMode.descriptor.id),
              detail: () => 'document authoring available',
              async setActive(enabled) {
                const modes = agent.context.selection.minorModes.filter((id) => id !== authorMinorMode.descriptor.id);
                await agent.changeSelection({
                  axis: 'minorModes',
                  minorModes: enabled ? [...modes, authorMinorMode.descriptor.id] : modes,
                });
              },
            }),
          ],
        }
      : {}),
    toolRestrictions: [
      { minorMode: 'author', allowedTools: [OPEN_AUTHORING_FILE_TOOL_NAME, ...AUTHOR_FACADE_TOOL_NAMES] },
    ],
    resources: [
      { when: { minorMode: 'author' }, name: 'doompi-use-author', kind: 'skill', read: () => readAuthorPrompt() },
    ],
    tools: createAuthorTools(createAuthorCatalog()).map((tool) => ({
      ...tool,
      when: { minorMode: 'author' },
    })),
    commands: [createAuthorCommand()],
    hooks: [
      {
        when: { minorMode: 'author' },
        event: 'before_agent_start',
        handle(event) {
          const systemPrompt = typeof event.systemPrompt === 'string' ? event.systemPrompt : '';
          return { systemPrompt: `${systemPrompt}\n\n${AUTHOR_GUIDANCE}`.trim() };
        },
      },
    ],
  }),
});

export default authorServerFacet;
