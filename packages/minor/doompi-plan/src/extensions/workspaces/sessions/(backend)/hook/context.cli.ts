import { defineCliHook, type WithRoot } from '@agimon-ai/doompi-core/extensionFile';
import type { PiEventHandlers } from '@agimon-ai/doompi-core/piExtension';

type Root = Awaited<ReturnType<typeof import('../root.cli').default>>['value'];

export default defineCliHook(
  (context: WithRoot<unknown, Root>): NonNullable<PiEventHandlers['context']> => context.root.events!.context!,
);
