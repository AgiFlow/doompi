import { type DoomHeadlessHook, type DoomHeadlessResource } from '@agimon-ai/doompi-extension-contracts/headless';

import { readHookResource } from '../services/hookResource';
function hookEntry(event: Readonly<Record<string, unknown>>): Record<string, unknown> {
  return {
    version: 1,
    event: typeof event.type === 'string' ? event.type : 'headless-hook',
    data: event,
  };
}

export const hookResource: DoomHeadlessResource = {
  name: 'doompi-author-hook',
  kind: 'skill',
  read: readHookResource,
};

export const serverHooks: DoomHeadlessHook[] = [
  {
    event: 'before_agent_start',
    handle: (event, execution) => execution.session.appendCustomEntry('doom-hook', hookEntry(event)),
  },
  {
    event: 'tool_result',
    handle: (event, execution) => execution.session.appendCustomEntry('doom-hook', hookEntry(event)),
  },
  {
    event: 'agent_settled',
    handle: (event, execution) => execution.session.appendCustomEntry('doom-hook', hookEntry(event)),
  },
  {
    event: 'session_shutdown',
    handle(_event, execution) {
      execution.client.setStatus('doom-hook', undefined);
    },
  },
];
