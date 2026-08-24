import { defineWebPlugin } from '@agimon-ai/doompi-web-contracts';

/**
 * This package's cockpit presence: pure metadata. The selection bar renders
 * the minor-mode entry and folds in what the session reports through the 'goal' footer status.
 */
export const webPlugin = defineWebPlugin({
  id: 'goal',
  minorModes: [{ name: 'goal', keys: 'g e', statusKey: 'goal', order: 40 }],
});
