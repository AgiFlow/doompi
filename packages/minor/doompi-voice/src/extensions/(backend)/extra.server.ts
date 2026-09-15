import type { DoomServerPluginDefinition } from '@agimon-ai/doompi-core/server-facet';

import { voiceClientSettingsApi } from '../../services/voiceControllerClientSettingsApi';
import { createVoiceMediaWakeChannel, createVoiceOwnershipChannel } from '../../services/voiceControllerMediaHubChannel';

export default (({ host }) =>
  host.scope === 'session'
    ? {}
    : {
        ...(host.scope === 'global' ? { api: [voiceClientSettingsApi] } : {}),
        channels: [createVoiceMediaWakeChannel, createVoiceOwnershipChannel],
      }) satisfies NonNullable<DoomServerPluginDefinition['global']>;
