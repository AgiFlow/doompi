import { defineWebPlugin } from '@agimon-ai/doompi-core/web';

/**
 * This package's cockpit presence: pure metadata. The selection bar renders
 * the profile axis from what the session reports through the 'doom-profile'
 * footer status; a session with no profiles publishes nothing and the axis
 * stays off the bar.
 */
export const webPlugin = defineWebPlugin({
  id: 'profile',
  session: {
    selectionAxes: [
      { name: 'profile', command: 'profile', statusKey: 'doom-profile', emptyLabel: 'no profile', order: 10 },
    ],
  },
});
