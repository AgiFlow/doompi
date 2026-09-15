import { defineRoutedContribution, type WithRoot } from '@agimon-ai/doompi-core/extension-file';
type Runtime = Awaited<ReturnType<typeof import('../root.cli').default>>['value'];

type Context = WithRoot<unknown, Runtime>;
export default defineRoutedContribution((context: Context) => context.root.events!['before_agent_start']!, {});
