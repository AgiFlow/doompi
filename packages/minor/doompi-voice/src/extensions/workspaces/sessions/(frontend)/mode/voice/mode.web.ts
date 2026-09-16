import { defineMinorModeFile } from '@agimon-ai/doompi-core/web';

export default defineMinorModeFile({
  name: 'voice',
  modeId: 'voice-auto',
  keys: 'v e',
  statusKey: 'doom-voice',
  order: 60,
});
