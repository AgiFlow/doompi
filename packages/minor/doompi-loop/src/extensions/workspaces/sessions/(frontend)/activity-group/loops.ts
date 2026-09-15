import { defineRoutedContribution } from '@agimon-ai/doompi-core/extension-file';

import { LOOP_VIEW_STATUS_KEY } from '../../../../../types/loopView';
import { LOOPS_ACTIVITY_SOURCE } from '../_lib/loopActivitySource';

export default defineRoutedContribution(
  { keys: 'l l', statusKey: LOOP_VIEW_STATUS_KEY, activeSource: LOOPS_ACTIVITY_SOURCE, order: 40 },
  {},
);
