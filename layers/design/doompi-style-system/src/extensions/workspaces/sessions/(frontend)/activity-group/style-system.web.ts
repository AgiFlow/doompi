import { defineActivityGroup } from '@agimon-ai/doompi-core/web';

import { styleSystemTab } from '../_components/StyleSystemBrowser';

export default defineActivityGroup({
  name: 'style system',
  keys: '',
  activeSource: { subscribe: () => () => undefined, isActive: () => false },
  marksBackgroundWork: false,
  transientTab: styleSystemTab,
  order: 25,
});
