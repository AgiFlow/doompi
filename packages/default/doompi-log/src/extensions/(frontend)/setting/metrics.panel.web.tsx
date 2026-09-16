import { defineSettingsPanel } from '@agimon-ai/doompi-core/web';

import { MetricsPanel } from './_components/MetricsPanel';
export default defineSettingsPanel({
  label: 'metrics',
  detail: 'where this machine spent its tokens and its money',
  component: MetricsPanel,
});
