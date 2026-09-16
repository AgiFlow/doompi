import { defineMethod } from '@agimon-ai/doompi-core/extension-file';
import type { DoomServerPluginContext } from '@agimon-ai/doompi-core/server-facet';

import { createAuthorBridgeMethod } from '../../../services/authorBridgeMethod';

export default defineMethod(({ host }: DoomServerPluginContext) =>
  host.scope === 'session'
    ? { register: () => ({ dispose: () => undefined }) }
    : createAuthorBridgeMethod(host.scope, host),
);
