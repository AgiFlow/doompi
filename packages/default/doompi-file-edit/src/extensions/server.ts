import { defineServerPlugin } from '@agimon-ai/doompi-core/server-facet';

import { PACKAGE_SOURCE } from '../constants/package';
import { createFileEditSession } from '../controllers/fileEditSession';
import { createFilesChannel } from '../controllers/webFilesChannel';
export const fileEditsServerFacet = defineServerPlugin({
  name: PACKAGE_SOURCE,
  global: { channels: [createFilesChannel] },
  workspace: { channels: [createFilesChannel] },
  session: createFileEditSession,
});
export default fileEditsServerFacet;
