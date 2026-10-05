import { defineSlotFile } from '@agimon-ai/doompi-core/web';

import { parseAuthorOpenSourceAction } from '../../../../../types/authorPreview';

export default defineSlotFile({
  slot: 'author.open-source',
  parse: parseAuthorOpenSourceAction,
});
