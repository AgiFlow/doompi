import { defineCliCommand, type WithRoot } from '@agimon-ai/doompi-core/extension-file';

import { createAuthorCommand } from '../../../../../services/authorCommand';
import type { AuthorExtensionService } from '../../../../../types/extension';

// The terminal takes the command as a native Pi declaration, so this half names
// itself through createAuthorCommand rather than through the generated entry.
export default defineCliCommand((context: WithRoot<unknown, { readonly service?: AuthorExtensionService }>) =>
  createAuthorCommand(context.root.service),
);
