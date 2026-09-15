import { defineLeaderBinding } from '@agimon-ai/doompi-core/web';
const EXTENSION_GROUP = { key: 'e', label: 'extension', detail: 'tools, skills and config' };
export default defineLeaderBinding({
  path: [EXTENSION_GROUP, { key: 'f', label: 'files', detail: 'files this session changed' }],
  command: 'file-edits',
});
