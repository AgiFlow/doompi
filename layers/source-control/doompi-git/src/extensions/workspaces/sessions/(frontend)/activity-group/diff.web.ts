import { defineActivityGroup } from '@agimon-ai/doompi-core/web';

import { reviewTab } from '../_components/GitReviewPanel';
import { gitChangesActivitySource } from '../_lib/gitChangesStore';

export default defineActivityGroup({
  keys: 'g d',
  activeSource: gitChangesActivitySource,
  marksBackgroundWork: false,
  transientTab: reviewTab,
  order: 28,
});
