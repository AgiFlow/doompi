import { defineRoutedContribution, type WithRoot } from '@agimon-ai/doompi-core/extension-file';

type Root = Awaited<ReturnType<typeof import('../root.cli').default>>['value'];

export default defineRoutedContribution(
  (context: WithRoot<unknown, Root>) => context.root.events!.before_agent_start!,
  {},
);
