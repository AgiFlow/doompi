import { defineRoute, type WithRoot } from '@agimon-ai/doompi-core/extensionFile';
import type { DoomServerPluginContext } from '@agimon-ai/doompi-core/serverFacet';

type AuthorServerScope = Awaited<ReturnType<typeof import('../../root.server').default>>['value'];

export default defineRoute((context: WithRoot<DoomServerPluginContext, AuthorServerScope>) => context.root.api);
