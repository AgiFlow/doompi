import { defineSettingsPanel } from '@agimon-ai/doompi-core/web';

import { MetricsPanel } from './_components/MetricsPanel';
export default defineSettingsPanel({
  label: 'metrics',
  detail: 'recorded usage, token attribution and issues',
  component: MetricsPanel,
});
