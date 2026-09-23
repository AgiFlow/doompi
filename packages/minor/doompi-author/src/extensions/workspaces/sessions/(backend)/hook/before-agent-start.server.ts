import { defineHook } from '@agimon-ai/doompi-core/extensionFile';

import { AUTHOR_GUIDANCE } from '../../../../../constants/author';

export default defineHook<'before_agent_start'>({
  when: { state: { 'minor-mode': 'author' }, attribution: { kind: 'minor', mode: 'author' } },
  event: 'before_agent_start',
  handle(event) {
    const systemPrompt = typeof event.systemPrompt === 'string' ? event.systemPrompt : '';
    return { systemPrompt: `${systemPrompt}\n\n${AUTHOR_GUIDANCE}`.trim() };
  },
});
