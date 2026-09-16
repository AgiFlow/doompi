import { defineContextAction } from '@agimon-ai/doompi-core/web';

import { subagentsTab } from '../_components/SubagentsPanel';
import { openAgentCatalogForContext } from '../_lib/catalogStore';

/** Offered on any work item another plugin presents. The filename is the action id. */
export default defineContextAction({
  label: 'Launch Agent',
  detail: 'Choose an agent, review the task, then launch it.',
  kinds: ['work-item'],
  order: 10,
  run: (context) => openAgentCatalogForContext(context, subagentsTab),
});
