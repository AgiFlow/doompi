import { defineWebLifecycle } from '@agimon-ai/doompi-core/web';

import { startVoiceMediaRuntime } from './_components/VoiceMediaRuntime';

export default defineWebLifecycle(startVoiceMediaRuntime);
