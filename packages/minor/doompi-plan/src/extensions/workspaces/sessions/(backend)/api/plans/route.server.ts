import { defineRoute, type WithRoot } from '@agimon-ai/doompi-core/extensionFile';

type Root = Awaited<ReturnType<typeof import('../../root.server').default>>['value'];

export default defineRoute((context: WithRoot<unknown, Root>) => context.root.api![0]!);
