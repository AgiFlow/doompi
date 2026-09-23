import { defineResource } from '@agimon-ai/doompi-core/extensionFile';

import { createDoompiUseUserFeedbackResource } from './_lib/doompi-use-user-feedback.cli';

export default defineResource(createDoompiUseUserFeedbackResource(import.meta.url));
