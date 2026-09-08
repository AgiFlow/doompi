import { BookmarkPlusIcon, OptionLabel, OptionRow } from '@agimon-ai/doompi-web-components';
import { requestPromptDialogOpen } from '../lib/messagePromptDraft.ts';

/**
 * The library's entry in the composer's '+' menu.
 *
 * DESIGN PATTERNS:
 * - Stateless on purpose. The menu unmounts this on every close, so it owns
 *   the click and nothing else; the dialog and its state live in the overlay.
 * - role="menuitem" overrides OptionRow's listbox default, because this row
 *   sits in a menu rather than in a list of choices over one field.
 *
 * AVOID:
 * - Holding dialog state, loading prompts, or subscribing to anything here.
 */

export function PromptsComposerMenuItem() {
  return (
    <OptionRow
      role="menuitem"
      density="compact"
      data-testid="composer-menu-prompts"
      className="w-full text-sm text-doom-text hover:bg-doom-tint-blue"
      onClick={requestPromptDialogOpen}
    >
      <BookmarkPlusIcon className="h-3 w-3 shrink-0" />
      <OptionLabel density="compact">Prompt template</OptionLabel>
    </OptionRow>
  );
}
