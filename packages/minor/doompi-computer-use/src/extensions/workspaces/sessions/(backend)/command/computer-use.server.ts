import { defineServerCommand, type WithRoot } from '@agimon-ai/doompi-core/extensionFile';
type Runtime = Awaited<ReturnType<typeof import('../root.server').default>>['value'];

type Context = WithRoot<unknown, Runtime>;
export default defineServerCommand((context: Context) => context.root.commands![0]!);
