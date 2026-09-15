import { defineResource } from '@agimon-ai/doompi-core/extension-file';

import { createDoompiUseUserFeedbackResource } from './_lib/doompi-use-user-feedback.cli';

export default defineResource(createDoompiUseUserFeedbackResource(import.meta.url));
