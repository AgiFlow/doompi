import { defineRoutedContribution } from '@agimon-ai/doompi-core/extension-file';

import { registerTaskCollapseShortcut, TaskOverlay } from '../(frontend)/overlay/_lib/taskOverlay';
import { createTaskRoot } from './_lib/root.cli';

const contribution = createTaskRoot({
  createOverlay: (options) => new TaskOverlay(options),
  registerCollapseShortcut: registerTaskCollapseShortcut,
});

export default defineRoutedContribution(contribution, {});
