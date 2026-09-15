import { defineRoutedContribution, type WithRoot } from '@agimon-ai/doompi-core/extension-file';
import type { PiToolContribution } from '@agimon-ai/doompi-core/pi-extension';
type Runtime = Awaited<ReturnType<typeof import('../root.cli').default>>['value'];

type Context = WithRoot<unknown, Runtime>;
export default defineRoutedContribution((context: Context): PiToolContribution => context.root.tools![0]!, {});
