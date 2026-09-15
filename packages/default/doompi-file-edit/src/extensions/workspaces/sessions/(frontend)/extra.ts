import type { WebPluginDefinition } from '@agimon-ai/doompi-core/web';

import { filesStatusKey } from '../../../../types/webFiles';
import { fileLinks } from '../../../../web/components/fileLinks';
import { FilesActivitySection } from '../../../../web/components/FilesActivitySection';
import { filesChannel } from '../../../../web/stores/filesStore';
const EXTENSION_GROUP = { key: 'e', label: 'extension', detail: 'tools, skills and config' };
export default {
  channels: [filesChannel],
  activityGroups: [
    {
      name: 'files',
      keys: 'e f',
      statusKey: filesStatusKey,
      hideWhenEmpty: true,
      marksBackgroundWork: false,
      order: 15,
    },
  ],
  activitySections: [{ id: 'files', component: FilesActivitySection }],
  fileLinks,
  leaderBindings: [
    {
      id: 'file-edit.files',
      path: [EXTENSION_GROUP, { key: 'f', label: 'files', detail: 'files this session changed' }],
      command: 'file-edits',
    },
  ],
} satisfies NonNullable<WebPluginDefinition['session']>;
