import { defineLeaderBinding } from '@agimon-ai/doompi-core/web';

import { reviewTab } from '../_components/GitReviewPanel';

export default defineLeaderBinding({
  path: [
    { key: 'g', label: 'git' },
    { key: 'd', label: 'diff', detail: 'review this checkout’s changes' },
  ],
  run: (context) => context.openTransientTab(reviewTab()),
});
