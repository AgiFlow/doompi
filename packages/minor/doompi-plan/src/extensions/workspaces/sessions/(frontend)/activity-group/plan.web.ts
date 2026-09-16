import { defineActivityGroup } from '@agimon-ai/doompi-core/web';

import { PLAN_STATUS_KEY } from '../../../../../types/planApi';

// Keyed off the saved plan rather than the mode because the plan remains useful
// while it is being implemented after the read-only mode exits.
export default defineActivityGroup({
  name: 'plan',
  keys: 'p e',
  statusKey: PLAN_STATUS_KEY,
  marksBackgroundWork: false,
  order: 25,
});
