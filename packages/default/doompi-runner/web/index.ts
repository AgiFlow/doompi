import { defineWebPlugin } from '@agimon-ai/doompi-web-contracts';

/**
 * This package's cockpit presence: pure metadata. The activity dock shows the
 * runners group whenever the session publishes the 'doom-runner-runners'
 * footer status, with its content as the live summary.
 */
export const webPlugin = defineWebPlugin({
  id: 'runner',
  activityGroups: [{ name: 'runners', keys: 'r l', statusKey: 'doom-runner-runners', order: 20 }],
});
