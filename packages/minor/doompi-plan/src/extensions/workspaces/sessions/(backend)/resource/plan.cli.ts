import { defineResource, type WithRoot } from '@agimon-ai/doompi-core/extension-file';

type Root = Awaited<ReturnType<typeof import('../root.cli').default>>['value'];

export default defineResource((context: WithRoot<unknown, Root>) => context.root.resources![0]!);
