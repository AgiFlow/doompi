import { defineActivityGroup } from '@agimon-ai/doompi-core/web';

import { filesStatusKey } from '../../../../../types/webFiles';
export default defineActivityGroup({
  keys: 'e f',
  statusKey: filesStatusKey,
  hideWhenEmpty: true,
  marksBackgroundWork: false,
  order: 15,
});
