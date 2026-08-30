import { defineWebPlugin } from '@agimon-ai/doompi-web-contracts';
import { FilesActivitySection } from './FilesActivitySection.tsx';
import { filesChannel } from './filesStore.ts';
import { filesStatusKey } from '../src/types/webFiles.ts';

/**
 * This package's cockpit presence: the files this session changed, in the
 * activity dock, each opening its own transient tab.
 *
 * There is no declared tab. A file is the thing a reader opens, not a list of
 * them, and the dock already answers "which files"; a second permanent tab
 * holding the same list would only add a place for the two to disagree.
 *
 * The group's key chip reads 'e f', which is the path the TUI already
 * documents for this package (FILE_EDIT_LEADER_CONTRIBUTION in
 * src/adapters/pi/extension.ts), so the two surfaces name the same thing.
 */
const EXTENSION_GROUP = { key: 'e', label: 'extension', detail: 'tools, skills and config' };

/** The named export the generated plugin registry imports. */
export const webPlugin = defineWebPlugin({
  id: 'files',
  channels: [filesChannel],
  // hideWhenEmpty: a session that has changed nothing has no files to list,
  // and the group returns as soon as it changes one. Changed files are session
  // history, not background work, so their presence never marks the session busy.
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
  // Same name as the group: the dock renders this inside it, in place of the
  // session's one-line summary.
  activitySections: [{ id: 'files', component: FilesActivitySection }],
  leaderBindings: [
    {
      id: 'file-edit.files',
      path: [EXTENSION_GROUP, { key: 'f', label: 'files', detail: 'files this session changed' }],
      command: 'file-edits',
    },
  ],
});
