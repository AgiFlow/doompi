import { defineServerTool, type WithRoot } from '@agimon-ai/doompi-core/extension-file';
type Runtime = Awaited<ReturnType<typeof import('../root.server').default>>['value'];

type Context = WithRoot<unknown, Runtime>;
export default defineServerTool((context: Context) => context.root.tools![2]!);
