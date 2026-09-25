import { defineActivityGroup } from '@agimon-ai/doompi-core/web';

import { voiceGlobalActivitySource } from '../_lib/voiceMediaWakeStore';

export default defineActivityGroup({
  name: 'voice',
  keys: 'v e',
  statusKey: 'doom-voice',
  activeSource: voiceGlobalActivitySource,
  hideWhenEmpty: true,
  marksBackgroundWork: false,
  placement: 'bottom',
  order: 60,
});
