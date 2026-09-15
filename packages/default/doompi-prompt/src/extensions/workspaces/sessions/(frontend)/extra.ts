import type { WebPluginDefinition } from '@agimon-ai/doompi-core/web';
import { BookmarkPlusIcon } from '@agimon-ai/doompi-web-components';

import { PromptsComposerMenuItem } from '../../../../web/components/PromptsComposerMenuItem';
import { PromptsDialogHost } from '../../../../web/components/PromptsDialogHost';
import { requestMessagePromptDraft } from '../../../../web/lib/messagePromptDraft';
export default {
  composerMenuItems: [{ id: 'template', component: PromptsComposerMenuItem }],
  overlays: [{ id: 'dialog-host', component: PromptsDialogHost }],
  userMessageActions: [
    { id: 'save', label: 'Save as prompt', icon: BookmarkPlusIcon, order: 40, run: requestMessagePromptDraft },
  ],
} satisfies NonNullable<WebPluginDefinition['session']>;
