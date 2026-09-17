import { defineSlotFile } from '@agimon-ai/doompi-core/web';

import { parseAuthorPreviewAction } from '../../../../../types/authorPreview';

/** Typed data slot for preview launchers that need Author's focused source. */
export default defineSlotFile({
  slot: 'author.preview-action',
  parse: parseAuthorPreviewAction,
});
