import type { DoomServerPluginDefinition } from '@agimon-ai/doompi-core/server-facet';

import { createAuthorBridgeMethod } from '../../controllers/authorBridgeMethod';
import { createAuthorChannel } from '../../controllers/webAuthorChannel';

export default (({ host }) =>
  host.scope === 'session'
    ? {}
    : {
        channels: [createAuthorChannel],
        methods: [createAuthorBridgeMethod(host.scope, host)],
      }) satisfies NonNullable<DoomServerPluginDefinition['global']>;
