import { defineActivityGroup } from '@agimon-ai/doompi-core/web';

export default defineActivityGroup({
  name: 'voice',
  keys: 'v e',
  statusKey: 'doom-voice',
  hideWhenEmpty: true,
  marksBackgroundWork: false,
  placement: 'bottom',
  order: 60,
});
