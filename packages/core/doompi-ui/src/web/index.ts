import { defineWebPlugin } from '@agimon-ai/doompi-web-contracts';
import { FindToolMessage } from './FindToolMessage.tsx';
import { LsToolMessage } from './LsToolMessage.tsx';
import { WriteToolMessage } from './WriteToolMessage.tsx';

/**
 * This package's cockpit presence: timeline cards for the Pi builtins whose
 * UI this package re-registers and no default package replaces. read, edit,
 * and grep belong to doompi-read, doompi-edit, and doompi-grep, which claim
 * them with their own cards.
 */
export const webPlugin = defineWebPlugin({
  id: 'builtin-tools',
  toolRenderers: [
    { tools: ['write'], message: WriteToolMessage },
    { tools: ['find'], message: FindToolMessage },
    { tools: ['ls'], message: LsToolMessage },
  ],
});
