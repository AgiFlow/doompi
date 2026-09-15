import type { WebPluginDefinition } from '@agimon-ai/doompi-core/web';

import { BashToolMessage } from '../../../../web/components/BashToolMessage';
import { RunnersActivitySection } from '../../../../web/components/RunnersActivitySection';
import { runnersTab } from '../../../../web/components/RunnersPanel';
import { runnerActivitySource, runnerRunsChannel } from '../../../../web/stores/runnersStore';
export default {
  channels: [runnerRunsChannel],
  activityGroups: [
    {
      name: 'runners',
      keys: 'r l',
      statusKey: 'doom-runner-runners',
      activeSource: runnerActivitySource,
      transientTab: runnersTab,
      order: 20,
    },
  ],
  activitySections: [{ id: 'runners', component: RunnersActivitySection }],
  toolRenderers: [{ tools: ['bash'], message: BashToolMessage }],
} satisfies NonNullable<WebPluginDefinition['session']>;
