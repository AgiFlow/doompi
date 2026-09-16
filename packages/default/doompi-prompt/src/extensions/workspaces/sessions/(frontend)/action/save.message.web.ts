import { defineUserMessageAction } from '@agimon-ai/doompi-core/web';
import { BookmarkPlusIcon } from '@agimon-ai/doompi-web-components';

import { requestMessagePromptDraft } from '../_lib/messagePromptDraft';
export default defineUserMessageAction({
  label: 'Save as prompt',
  icon: BookmarkPlusIcon,
  order: 40,
  run: requestMessagePromptDraft,
});
