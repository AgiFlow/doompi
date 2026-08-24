import { defineWebPlugin } from '@agimon-ai/doompi-web-contracts';

/**
 * This package's cockpit presence: pure metadata. The selection bar renders
 * the minor-mode entry and folds in what the session reports through the 'doom-loop' footer status.
 */
export const webPlugin = defineWebPlugin({
  id: 'loop',
  minorModes: [{ name: 'loop', keys: 'l l', statusKey: 'doom-loop', order: 30 }],
});
