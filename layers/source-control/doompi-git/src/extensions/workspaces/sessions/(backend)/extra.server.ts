import type { DoomServerPluginContext } from '@agimon-ai/doompi-core/server-facet';

import { createGitSession } from '../../../../controllers/gitSession';

export default createGitSession as (context: DoomServerPluginContext) => ReturnType<typeof createGitSession>;
