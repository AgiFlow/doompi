import { defineCommand as defineRoutedCommand, type WithRoot } from '@agimon-ai/doompi-core/extension-file';

import { createAuthorCommand } from '../../../../../services/authorCommand';
import type { AuthorExtensionService } from '../../../../../types/extension';

export default defineRoutedCommand((context: WithRoot<unknown, { readonly service?: AuthorExtensionService }>) =>
  createAuthorCommand(context.root.service),
);
