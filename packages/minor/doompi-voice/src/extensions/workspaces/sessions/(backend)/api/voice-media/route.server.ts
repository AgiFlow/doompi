import { defineRoute, type WithRoot } from '@agimon-ai/doompi-core/extensionFile';

import type root from '../../root.server';

type Context = WithRoot<unknown, Awaited<ReturnType<typeof root>>['value']>;

export default defineRoute((context: Context) => context.root.api![1]!);
