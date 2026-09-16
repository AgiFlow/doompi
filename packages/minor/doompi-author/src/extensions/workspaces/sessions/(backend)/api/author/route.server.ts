import { defineRoute, type WithRoot } from '@agimon-ai/doompi-core/extension-file';
import type { DoomServerPluginContext } from '@agimon-ai/doompi-core/server-facet';

type AuthorServerScope = Awaited<ReturnType<typeof import('../../root.server').default>>['value'];

export default defineRoute((context: WithRoot<DoomServerPluginContext, AuthorServerScope>) => context.root.api);
