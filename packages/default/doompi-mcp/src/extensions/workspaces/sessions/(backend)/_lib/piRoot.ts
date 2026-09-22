import type { PiPluginContext } from '@agimon-ai/doompi-core/piExtension';

import { createMcpPiRuntime } from '../../../../../services/piRuntime';
export const createMcpPiRoot = ({ runtime }: PiPluginContext) => {
  if (!runtime) throw new Error('MCP requires the Cordis runtime mode.');
  const state = createMcpPiRuntime(runtime);
  return { value: state, services: state.services, onDispose: () => state.onDispose() };
};
export type McpPiScope = Awaited<ReturnType<typeof createMcpPiRoot>>['value'];
