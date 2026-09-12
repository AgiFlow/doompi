import { BookmarkPlusIcon } from '@agimon-ai/doompi-web-components';
import { defineWebPlugin } from '@agimon-ai/doompi-core/web';
import { PromptsComposerMenuItem } from '../web/components/PromptsComposerMenuItem';
import { PromptsDialogHost } from '../web/components/PromptsDialogHost';
import { requestMessagePromptDraft } from '../web/lib/messagePromptDraft';

/**
 * This package's cockpit presence: one composer menu entry and the dialog it
 * opens.
 *
 * No tab, and no activity group. The library is not a place to sit in, nor is
 * it something the session reports on; it is something reached for while
 * writing a message. So it lives in the composer's '+' menu, beside file
 * upload, and the picking happens in a dialog over the conversation.
 *
 * The dialog is an overlay rather than part of the menu entry, because the
 * menu unmounts its entries on every close and because the timeline's "Save as
 * prompt" action has to reach the same dialog without any menu being open.
 */

export const webPlugin = defineWebPlugin({
  id: 'prompts',
  session: {
    composerMenuItems: [{ id: 'template', component: PromptsComposerMenuItem }],
    overlays: [{ id: 'dialog-host', component: PromptsDialogHost }],
    userMessageActions: [
      {
        id: 'save',
        label: 'Save as prompt',
        icon: BookmarkPlusIcon,
        order: 40,
        run: requestMessagePromptDraft,
      },
    ],
  },
});
