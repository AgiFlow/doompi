import { type DoomHeadlessHook } from '@agimon-ai/doompi-core/headless';

function hookEntry(event: Readonly<Record<string, unknown>>): Record<string, unknown> {
  return {
    version: 1,
    event: typeof event.type === 'string' ? event.type : 'headless-hook',
    data: event,
  };
}

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
