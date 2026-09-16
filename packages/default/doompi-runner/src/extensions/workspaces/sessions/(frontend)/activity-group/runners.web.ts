import { defineActivityGroup } from '@agimon-ai/doompi-core/web';

import { runnersTab } from '../_components/RunnersPanel';
import { runnerActivitySource } from '../_lib/runnersStore';
export default defineActivityGroup({
  keys: 'r l',
  statusKey: 'doom-runner-runners',
  activeSource: runnerActivitySource,
  transientTab: runnersTab,
  order: 20,
});
