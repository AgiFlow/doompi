import { defineLeaderBinding } from '@agimon-ai/doompi-core/web';

import { reviewTab } from '../_components/GitReviewPanel';

export default defineLeaderBinding({
  path: [
    // The shared g prefix must keep the existing Goal group's label.
    { key: 'g', label: 'goal' },
    { key: 'd', label: 'diff', detail: 'review this checkout’s changes' },
  ],
  run: (context) => context.openTransientTab(reviewTab()),
});
