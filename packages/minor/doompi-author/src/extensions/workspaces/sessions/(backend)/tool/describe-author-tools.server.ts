import { defineTool, type WithRoot } from '@agimon-ai/doompi-core/extensionFile';

import { AUTHOR_TOOL_WHEN, createAuthorTools, type AuthorToolRoot } from '../../../../../services/authorTools';

export default defineTool((context: WithRoot<unknown, AuthorToolRoot>) => ({
  ...createAuthorTools(context.root.catalog, context.root.assertAvailable)[1]!,
  when: AUTHOR_TOOL_WHEN,
}));
