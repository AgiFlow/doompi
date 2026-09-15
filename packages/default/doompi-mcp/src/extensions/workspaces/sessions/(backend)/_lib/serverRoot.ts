import { createMcpServerRuntime } from '../../../../../services/serverRuntime';
export const createMcpServerRoot = () => {
  const runtime = createMcpServerRuntime();
  return { value: runtime, activities: runtime.activities };
};
export type McpServerScope = Awaited<ReturnType<typeof createMcpServerRoot>>['value'];
