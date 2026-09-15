import { defineCliHook, type WithRoot } from '@agimon-ai/doompi-core/extension-file';

import type root from '../root.cli';

type Context = WithRoot<unknown, Awaited<ReturnType<typeof root>>['value']>;

export default defineCliHook((context: Context) => context.root.events!['tool_execution_start']!);
