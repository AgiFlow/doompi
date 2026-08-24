import { defineWebPlugin } from '@agimon-ai/doompi-web-contracts';

/**
 * This package's cockpit presence: pure metadata. The selection bar renders
 * the minor-mode entry and folds in what the session reports through the 'plan-mode' footer status.
 */
export const webPlugin = defineWebPlugin({
  id: 'plan',
  minorModes: [{ name: 'plan', keys: 'p e', statusKey: 'plan-mode', order: 20 }],
});
