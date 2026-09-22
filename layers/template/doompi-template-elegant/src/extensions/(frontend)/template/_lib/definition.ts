import type { WebTemplateFile } from '@agimon-ai/doompi-core/web';

import { ElegantLayout } from '../_components/ElegantLayout';

export const elegantTemplate = {
  label: 'Elegant',
  description: 'A focused conversation with collapsible navigation, session controls, and activity.',
  contractVersion: 1,
  layout: ElegantLayout,
} satisfies WebTemplateFile;
