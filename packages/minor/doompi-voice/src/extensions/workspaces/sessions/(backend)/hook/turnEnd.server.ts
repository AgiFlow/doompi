import { defineHook, type WithRoot } from '@agimon-ai/doompi-core/extensionFile';

import type root from '../root.server';

type Context = WithRoot<unknown, Awaited<ReturnType<typeof root>>['value']>;

export default defineHook((context: Context) => context.root.hooks![1]!);
