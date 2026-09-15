import { defineRoutedContribution } from '@agimon-ai/doompi-core/extension-file';

import { GOAL_VIEW_STATUS_KEY } from '../../../../../types/goalView';

export default defineRoutedContribution(
  {
    keys: 'g e',
    statusKey: GOAL_VIEW_STATUS_KEY,
    marksBackgroundWork: false,
    hideWhenEmpty: true,
    order: 35,
  },
  {},
);
