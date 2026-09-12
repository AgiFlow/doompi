/**
 * doompi-voice's server facet.
 *
 * DESIGN PATTERNS:
 * - Object plugin. `inject` is declared on the facet itself, so the host mounts
 *   one fiber and knows the API is registered the moment it settles.
 * - Thin host adapter. It registers the package's API and returns the
 *   disposer; the surface itself stays in voiceSessionApi.
 * - Scope-aware. Voice media belongs to the session that owns capture and
 *   transcription, so the hub scope registers nothing.
 *
 * AVOID:
 * - Starting audio, processes or timers in apply. The API handler owns that
 *   lifecycle after the host registers it.
 */

import { readDoomHeadlessHost } from '@agimon-ai/doompi-extension-contracts/headless';
import {
  DOOM_SERVER_HOST_SERVICE,
  type DoomServerFacet,
  requireDoomServerHost,
} from '@agimon-ai/doompi-extension-contracts/server-facet';
import type { Context } from '@deepseek-ai/cordis';
import { voiceHeadlessFacet } from '../headless/facet.ts';
import { createVoiceMediaWakeChannel, createVoiceOwnershipChannel } from '../voiceMediaHubChannel.ts';
import { api } from '../voiceSessionApi.ts';

export const voiceServerFacet: DoomServerFacet = {
  inject: [DOOM_SERVER_HOST_SERVICE],
  apply(context: Context) {
    const host = requireDoomServerHost(context);
    if (host.scope === 'global' || host.scope === 'workspace') {
      const registrations = [
        host.registerChannel(createVoiceMediaWakeChannel()),
        host.registerChannel(createVoiceOwnershipChannel()),
      ];
      return () => {
        for (const registration of registrations.reverse()) registration.dispose();
      };
    }
    const headlessDisposer = readDoomHeadlessHost(context) ? voiceHeadlessFacet.apply(context) : undefined;
    if (host.scope !== 'session') return headlessDisposer;
    const registration = host.registerApi(api);
    return () => {
      headlessDisposer?.();
      registration.dispose();
    };
  },
};
