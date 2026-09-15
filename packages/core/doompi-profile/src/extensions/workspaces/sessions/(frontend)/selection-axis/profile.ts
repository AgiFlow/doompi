import { defineSelectionAxis } from '@agimon-ai/doompi-core/web';
export default defineSelectionAxis({
  name: 'profile',
  command: 'profile',
  statusKey: 'doom-profile',
  emptyLabel: 'no profile',
  order: 10,
});
