import { defineWebPlugin } from '@agimon-ai/doompi-core/web';

import { FindToolMessage } from '../web/components/FindToolMessage';
import { LsToolMessage } from '../web/components/LsToolMessage';
import { WriteToolMessage } from '../web/components/WriteToolMessage';

/**
 * This package's cockpit presence: timeline cards for the Pi builtins whose
 * UI this package re-registers and no default package replaces. read, edit,
 * and grep belong to doompi-read, doompi-edit, and doompi-grep, which claim
 * them with their own cards.
 */
export const webPlugin = defineWebPlugin({
  id: 'builtin-tools',
  session: {
    toolRenderers: [
      { tools: ['write'], message: WriteToolMessage },
      { tools: ['find'], message: FindToolMessage },
      { tools: ['ls'], message: LsToolMessage },
    ],
  },
});
