import { defineActivityGroup } from '@agimon-ai/doompi-core/web';

import { GOAL_VIEW_STATUS_KEY } from '../../../../../types/goalView';

export default defineActivityGroup({
  keys: 'g e',
  statusKey: GOAL_VIEW_STATUS_KEY,
  marksBackgroundWork: false,
  hideWhenEmpty: true,
  order: 35,
});
