import { defineLeaderBinding } from '@agimon-ai/doompi-core/web';
export default defineLeaderBinding({
  id: 'author.toggle',
  path: [
    { key: 'o', label: 'other', detail: 'optional modes and tools' },
    { key: 'a', label: 'author', detail: 'enable or disable focused document authoring' },
  ],
  command: 'minor author',
});
