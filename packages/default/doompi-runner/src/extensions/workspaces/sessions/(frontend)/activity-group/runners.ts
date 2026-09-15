import { defineActivityGroup } from '@agimon-ai/doompi-core/web';

import { runnersTab } from '../../../../../web/components/RunnersPanel';
import { runnerActivitySource } from '../../../../../web/stores/runnersStore';
export default defineActivityGroup({
  keys: 'r l',
  statusKey: 'doom-runner-runners',
  activeSource: runnerActivitySource,
  transientTab: runnersTab,
  order: 20,
});
