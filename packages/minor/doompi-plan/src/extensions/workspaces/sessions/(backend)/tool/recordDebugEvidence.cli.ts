import { defineCliTool, type WithRoot } from '@agimon-ai/doompi-core/extension-file';

type Root = Awaited<ReturnType<typeof import('../root.cli').default>>['value'];

export default defineCliTool((context: WithRoot<unknown, Root>) => context.root.tools![0]!);
