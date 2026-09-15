import type { DoomServerPluginContext } from '@agimon-ai/doompi-core/server-facet';

import { settingsApi } from '../../controllers/settingsApi';

export default ({ host }: DoomServerPluginContext) => (host.scope === 'session' ? {} : { api: [settingsApi] });
