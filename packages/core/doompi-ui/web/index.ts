import { defineWebPlugin } from '@agimon-ai/doompi-web-contracts';
import { FindToolCall, FindToolResult } from './FindToolCard.tsx';
import { LsToolCall, LsToolResult } from './LsToolCard.tsx';
import { WriteToolCall, WriteToolResult } from './WriteToolCard.tsx';

/**
 * This package's cockpit presence: timeline cards for the Pi builtins whose
 * UI this package re-registers and no default package replaces. read, edit,
 * and grep belong to doompi-read, doompi-edit, and doompi-grep, which claim
 * them with their own cards.
 */
export const webPlugin = defineWebPlugin({
  id: 'builtin-tools',
  toolRenderers: [
    { tools: ['write'], call: WriteToolCall, result: WriteToolResult },
    { tools: ['find'], call: FindToolCall, result: FindToolResult },
    { tools: ['ls'], call: LsToolCall, result: LsToolResult },
  ],
});
