import { defineResource } from '@agimon-ai/doompi-core/extensionFile';

import { createDoompiUseGitResource } from './_lib/doompi-use-git.cli';

export default defineResource(createDoompiUseGitResource(import.meta.url));
