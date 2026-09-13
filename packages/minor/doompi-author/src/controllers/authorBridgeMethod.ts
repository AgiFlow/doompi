import { defineServerMethod, type DoomServerHostService } from '@agimon-ai/doompi-core/server-facet';

import { authorBridgeMethod } from '../schemas/authorFacade';
import { authorChannelType } from '../types/webAuthor';

export function createAuthorBridgeMethod(scope: 'global' | 'workspace', host: DoomServerHostService) {
  return defineServerMethod(authorBridgeMethod(scope), ({ sessionId, message }, caller) => {
    if (!caller.connectionId) throw new Error('Author bridge requires an authenticated browser connection.');
    if (!host.context.receiveChannel?.(sessionId, authorChannelType, message, caller.connectionId))
      throw new Error('Author bridge session is outside this mount.');
    return {};
  });
}
