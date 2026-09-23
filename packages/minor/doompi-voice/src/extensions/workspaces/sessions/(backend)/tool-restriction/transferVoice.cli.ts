import { defineToolRestriction, type WithRoot } from '@agimon-ai/doompi-core/extensionFile';

import type root from '../root.cli';

type Context = WithRoot<unknown, Awaited<ReturnType<typeof root>>['value']>;

export default defineToolRestriction((context: Context) => context.root.toolRestrictions![1]!);
