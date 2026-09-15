import { defineResource, type WithRoot } from '@agimon-ai/doompi-core/extension-file';

import type root from '../root.cli';

type Context = WithRoot<unknown, Awaited<ReturnType<typeof root>>['value']>;

export default defineResource((context: Context) => context.root.resources![0]!);
