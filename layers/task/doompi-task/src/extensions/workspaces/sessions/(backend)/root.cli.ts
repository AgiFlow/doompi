import { defineRoot } from '@agimon-ai/doompi-core/extensionFile';

import { registerTaskCollapseShortcut, TaskOverlay } from '../(frontend)/overlay/_lib/taskOverlay';
import { createTaskRoot } from './_lib/root.cli';

export default defineRoot(
  createTaskRoot({
    createOverlay: (options) => new TaskOverlay(options),
    registerCollapseShortcut: registerTaskCollapseShortcut,
  }),
);
