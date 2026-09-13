import { definePiExtension } from '@agimon-ai/doompi-core/pi-extension';

import { HOOK_HELP_SKILL, PACKAGE_SOURCE } from '../constants/hook';
import { createHookHandlers } from '../controllers/hookHandlers';
import { createHookBinding } from '../services/hookRuntime';
import type { HookExtensionOptions } from '../services/hookRuntime/type';
export const hookExtension = definePiExtension<HookExtensionOptions>(PACKAGE_SOURCE, ({ pi, options }) => {
  const binding = createHookBinding(options ?? {});
  return {
    services: [binding.plugin],
    events: createHookHandlers(pi, binding.runtime),
    resources: [{ source: PACKAGE_SOURCE, moduleUrl: import.meta.url, skills: [HOOK_HELP_SKILL] }],
  };
});
export default hookExtension;
