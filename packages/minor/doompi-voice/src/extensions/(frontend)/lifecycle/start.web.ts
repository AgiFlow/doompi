import { defineWebLifecycle } from '@agimon-ai/doompi-core/web';

import { startVoiceMediaRuntime } from '../../workspaces/sessions/(frontend)/lifecycle/_components/VoiceMediaRuntime';

export default defineWebLifecycle(startVoiceMediaRuntime);
