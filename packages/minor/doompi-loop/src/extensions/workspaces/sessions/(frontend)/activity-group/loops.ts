import { defineActivityGroup } from '@agimon-ai/doompi-core/web';

import { LOOP_VIEW_STATUS_KEY } from '../../../../../types/loopView';
import { LOOPS_ACTIVITY_SOURCE } from '../_lib/loopActivitySource';

export default defineActivityGroup({
  keys: 'l l',
  statusKey: LOOP_VIEW_STATUS_KEY,
  activeSource: LOOPS_ACTIVITY_SOURCE,
  order: 40,
});
