import { defineWebPlugin } from '@agimon-ai/doompi-web-contracts';
import { MetricsPanel } from './MetricsPanel.tsx';

/**
 * This package's cockpit presence: one settings page.
 *
 * The page is drawn rather than declared as fields because it has nothing to
 * write. What a reader cannot otherwise reach is where the tokens and the cost
 * went, and that answer is a shape, not a value in a config file. The TUI
 * already answers it behind SPC h l; this is the same question asked from the
 * browser.
 */
export const webPlugin = defineWebPlugin({
  id: 'log',
  settingsPanels: [
    {
      id: 'metrics',
      label: 'metrics',
      detail: 'where this machine spent its tokens and its money',
      component: MetricsPanel,
    },
  ],
});
