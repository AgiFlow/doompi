import { defineCliHook, type WithRoot } from '@agimon-ai/doompi-core/extensionFile';

type Root = Awaited<ReturnType<typeof import('../root.cli').default>>['value'];

export default defineCliHook((context: WithRoot<unknown, Root>) => context.root.events!.tool_call!);
