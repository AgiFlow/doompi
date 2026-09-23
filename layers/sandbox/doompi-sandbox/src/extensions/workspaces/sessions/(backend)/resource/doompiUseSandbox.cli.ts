import { defineResource } from '@agimon-ai/doompi-core/extensionFile';

import { createSandboxHelpResource } from '../_lib/sandboxResources';

export default defineResource(createSandboxHelpResource(import.meta.url));
