import { createFileEditRuntime } from '../../../../../services/fileEditRuntime';
import { createFileEditDependencies } from '../../../../../tui/fileEditDependencies';
export const createFileEditPiRoot = () => {
  const runtime = createFileEditRuntime(createFileEditDependencies());
  return { value: runtime, services: runtime.services, onDispose: runtime.onDispose };
};
export type FileEditPiScope = Awaited<ReturnType<typeof createFileEditPiRoot>>['value'];
