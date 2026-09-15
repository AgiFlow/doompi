import type { WebPluginDefinition } from '@agimon-ai/doompi-core/web';

import { MetricsPanel } from '../../web/components/MetricsPanel';
export default {
  settingsPanels: [
    {
      id: 'metrics',
      label: 'metrics',
      detail: 'where this machine spent its tokens and its money',
      component: MetricsPanel,
    },
  ],
} satisfies NonNullable<WebPluginDefinition['global']>;
