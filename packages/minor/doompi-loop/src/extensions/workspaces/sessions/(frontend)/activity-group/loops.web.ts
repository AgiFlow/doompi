import { defineActivityGroup } from '@agimon-ai/doompi-core/web';

import { LOOP_VIEW_STATUS_KEY } from '../../../../../types/loopView';

export default defineActivityGroup({
  keys: 'l l',
  statusKey: LOOP_VIEW_STATUS_KEY,
  order: 40,
});
