import type { DoomServerPluginDefinition } from '@agimon-ai/doompi-core/server-facet';

import { voiceClientSettingsApi } from '../../controllers/voiceClientSettingsApi';
import { createVoiceMediaWakeChannel, createVoiceOwnershipChannel } from '../../controllers/voiceMediaHubChannel';

export default (({ host }) =>
  host.scope === 'session'
    ? {}
    : {
        ...(host.scope === 'global' ? { api: [voiceClientSettingsApi] } : {}),
        channels: [createVoiceMediaWakeChannel, createVoiceOwnershipChannel],
      }) satisfies NonNullable<DoomServerPluginDefinition['global']>;
