import { defineMethod } from '@agimon-ai/doompi-core/extensionFile';
import type { DoomServerPluginContext } from '@agimon-ai/doompi-core/serverFacet';

import { createAuthorBridgeMethod } from '../../../services/authorBridgeMethod';

export default defineMethod(({ host }: DoomServerPluginContext) =>
  host.scope === 'session'
    ? { register: () => ({ dispose: () => undefined }) }
    : createAuthorBridgeMethod(host.scope, host),
);
