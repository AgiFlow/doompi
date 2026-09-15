import { defineRoutedContribution, type WithRoot } from '@agimon-ai/doompi-core/extension-file';

type Root = Awaited<ReturnType<typeof import('../root.server').default>>['value'];

export default defineRoutedContribution((context: WithRoot<unknown, Root>) => context.root.toolRestrictions?.[0], {
  cardinality: 'optional',
});
