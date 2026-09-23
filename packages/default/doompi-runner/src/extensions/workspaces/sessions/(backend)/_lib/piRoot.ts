import type { PiPluginContext } from '@agimon-ai/doompi-core/piExtension';

import { createRunnerRuntime } from '../../../../../tui/runnerRuntime';
export const createRunnerPiRoot = ({ pi }: PiPluginContext) => {
  const runtime = createRunnerRuntime(pi);
  return { value: runtime, services: [runtime.plugin], onStart: runtime.start, onStop: runtime.stop };
};
export type RunnerPiScope = Awaited<ReturnType<typeof createRunnerPiRoot>>['value'];
