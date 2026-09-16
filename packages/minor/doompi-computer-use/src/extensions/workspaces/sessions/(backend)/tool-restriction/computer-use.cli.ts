import { defineToolRestriction, type WithRoot } from '@agimon-ai/doompi-core/extension-file';
type Runtime = Awaited<ReturnType<typeof import('../root.cli').default>>['value'];

type Context = WithRoot<unknown, Runtime>;
export default defineToolRestriction((context: Context) => context.root.toolRestrictions![0]!);
