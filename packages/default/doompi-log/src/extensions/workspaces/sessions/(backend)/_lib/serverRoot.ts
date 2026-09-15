import { createServerTelemetry } from '../../../../../services/serverTelemetry';
export const createLogServerRoot = () => {
  const runtime = createServerTelemetry();
  return { value: runtime, activities: runtime.activities };
};
export type LogServerScope = Awaited<ReturnType<typeof createLogServerRoot>>['value'];
