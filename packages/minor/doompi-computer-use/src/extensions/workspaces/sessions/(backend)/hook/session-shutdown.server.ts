import { defineRoutedContribution, type WithRoot } from '@agimon-ai/doompi-core/extensionFile';
type Runtime = Awaited<ReturnType<typeof import('../root.server').default>>['value'];

type Context = WithRoot<unknown, Runtime>;
export default defineRoutedContribution(
  (context: Context) => context.root.hooks?.find((hook) => hook.event === 'session_shutdown'),
  { cardinality: 'optional' },
);
