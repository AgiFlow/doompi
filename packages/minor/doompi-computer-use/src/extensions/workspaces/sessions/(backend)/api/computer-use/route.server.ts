import { defineRoutedContribution, type WithRoot } from '@agimon-ai/doompi-core/extensionFile';
type Runtime = Awaited<ReturnType<typeof import('../../root.server').default>>['value'];

type Context = WithRoot<unknown, Runtime>;
export default defineRoutedContribution(
  (context: Context) => context.root.api?.find((api) => api.basePath === 'computer-use'),
  { cardinality: 'optional' },
);
