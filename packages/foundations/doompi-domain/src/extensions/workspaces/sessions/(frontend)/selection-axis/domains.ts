import { defineSelectionAxis } from '@agimon-ai/doompi-core/web';
export default defineSelectionAxis({
  name: 'domains',
  command: 'domains',
  statusKey: 'doom-domain',
  emptyLabel: 'no domains',
  multi: true,
  order: 20,
});
