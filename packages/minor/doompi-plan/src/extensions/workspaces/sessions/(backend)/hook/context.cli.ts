import { defineRoutedContribution, type WithRoot } from '@agimon-ai/doompi-core/extension-file';
import type { PiEventHandlers } from '@agimon-ai/doompi-core/pi-extension';

type Root = Awaited<ReturnType<typeof import('../root.cli').default>>['value'];

export default defineRoutedContribution(
  (context: WithRoot<unknown, Root>): NonNullable<PiEventHandlers['context']> => context.root.events!.context!,
  {},
);
