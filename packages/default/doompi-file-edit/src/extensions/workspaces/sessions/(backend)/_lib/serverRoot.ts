import type { DoomServerPluginContext } from '@agimon-ai/doompi-core/server-facet';

import { createFileEditSession } from '../../../../../services/fileEditSession';
export const createFileEditServerRoot = (context: DoomServerPluginContext) => {
  const runtime = createFileEditSession(context);
  return { value: runtime, activities: runtime.activities };
};
export type FileEditServerScope = Awaited<ReturnType<typeof createFileEditServerRoot>>['value'];
