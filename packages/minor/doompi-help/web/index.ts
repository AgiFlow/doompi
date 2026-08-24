import { defineWebPlugin } from '@agimon-ai/doompi-web-contracts';

/**
 * This package's cockpit presence: pure metadata. The selection bar renders
 * the minor-mode entry and folds in what the session reports; no signal is published yet, so it shows as unavailable.
 */
export const webPlugin = defineWebPlugin({
  id: 'help',
  minorModes: [{ name: 'help', keys: 'h e', order: 10 }],
});
