import { DOOM_CORDIS_SERVER_SERVICES, type DoomCordisServerServices } from '@agimon-ai/doompi-core/cordisHost';
import type { PiPluginContext } from '@agimon-ai/doompi-core/piExtension';

import { createHookHandlers } from '../../../../../services/hookHandlers';
import { createHookBinding } from '../../../../../services/hookRuntime';
import {
  DOOM_HOOK_SESSION_SERVICE,
  type HookExtensionOptions,
  type HookRuntime,
} from '../../../../../services/hookRuntime/type';

export const createHookPiRoot = ({ pi, options, context }: PiPluginContext<HookExtensionOptions>) => {
  const binding = createHookBinding(options ?? {});
  const runtime = (): HookRuntime | undefined => {
    // The bridge publishes this accessor just before session_start. Never build
    // a second session instance for headless lifecycle handlers.
    const server = context.get(DOOM_CORDIS_SERVER_SERVICES) as DoomCordisServerServices | undefined;
    return server ? server.get<HookRuntime>(DOOM_HOOK_SESSION_SERVICE) : binding.runtime();
  };
  return { value: createHookHandlers(pi, runtime), services: [binding.plugin] };
};
export type HookPiScope = Awaited<ReturnType<typeof createHookPiRoot>>['value'];
