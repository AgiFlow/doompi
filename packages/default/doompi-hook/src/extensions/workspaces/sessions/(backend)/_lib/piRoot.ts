import type { PiPluginContext } from '@agimon-ai/doompi-core/pi-extension';

import { createHookHandlers } from '../../../../../services/hookHandlers';
import { createHookBinding } from '../../../../../services/hookRuntime';
import type { HookExtensionOptions } from '../../../../../services/hookRuntime/type';

export const createHookPiRoot = ({ pi, options }: PiPluginContext<HookExtensionOptions>) => {
  const binding = createHookBinding(options ?? {});
  return { value: createHookHandlers(pi, binding.runtime), services: [binding.plugin] };
};
export type HookPiScope = Awaited<ReturnType<typeof createHookPiRoot>>['value'];
