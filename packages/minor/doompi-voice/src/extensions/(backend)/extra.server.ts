import type { DoomServerPluginDefinition } from '@agimon-ai/doompi-core/server-facet';

import { voiceClientSettingsApi } from '../../services/voiceClientSettingsApi';
import { createVoiceMediaWakeChannel, createVoiceOwnershipChannel } from '../../services/voiceMediaHubChannel';

export default (({ host }) =>
  host.scope === 'session'
    ? {}
    : {
        ...(host.scope === 'global' ? { api: [voiceClientSettingsApi] } : {}),
        channels: [createVoiceMediaWakeChannel, createVoiceOwnershipChannel],
      }) satisfies NonNullable<DoomServerPluginDefinition['global']>;
