import { defineServerTool, type WithRoot } from '@agimon-ai/doompi-core/extension-file';

import type root from '../root.server';

type Context = WithRoot<unknown, Awaited<ReturnType<typeof root>>['value']>;

export default defineServerTool((context: Context) => context.root.tools![0]!);
