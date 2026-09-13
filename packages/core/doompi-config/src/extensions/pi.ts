import { definePiExtension } from '@agimon-ai/doompi-core/pi-extension';

import { CONFIG_HELP_SKILL, PACKAGE_SOURCE } from '../constants/config';
import { createConfigRuntime } from '../services/configRuntime';

export const registerConfigExtension = definePiExtension(PACKAGE_SOURCE, ({ pi }) => {
  const runtime = createConfigRuntime(pi);
  return {
    services: [runtime.plugin],
    resources: [{ source: PACKAGE_SOURCE, moduleUrl: import.meta.url, skills: [CONFIG_HELP_SKILL] }],
    events: { session_start: runtime.onSessionStart },
  };
});

export default registerConfigExtension;
