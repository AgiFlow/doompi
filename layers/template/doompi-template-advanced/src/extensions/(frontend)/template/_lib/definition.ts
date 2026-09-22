import type { WebTemplateFile } from '@agimon-ai/doompi-core/web';

import { AdvancedLayout } from '../_components/AdvancedLayout';

export const advancedTemplate = {
  label: 'Advanced',
  description: 'The full cockpit with persistent session navigation and an activity dock.',
  contractVersion: 1,
  layout: AdvancedLayout,
} satisfies WebTemplateFile;
