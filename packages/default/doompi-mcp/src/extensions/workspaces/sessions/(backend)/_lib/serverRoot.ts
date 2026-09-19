import { mountMcpHeadlessTools } from '../../../../../services/mcpHeadlessTools';
import { createMcpServerRuntime } from '../../../../../services/serverRuntime';
export const createMcpServerRoot = () => {
  const runtime = createMcpServerRuntime();
  return { value: runtime, activities: runtime.activities, services: [mountMcpHeadlessTools(runtime.tools)] };
};
export type McpServerScope = Awaited<ReturnType<typeof createMcpServerRoot>>['value'];
