import {
  Button,
  Dialog,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@agimon-ai/doompi-web-components';
import type { SessionFrameSender } from '@agimon-ai/doompi-web-contracts';
import { useState } from 'react';
import type { SavedPromptView } from '../types/webPrompts.ts';
import { PromptPickerList } from './PromptPickerList.tsx';
import { commitDraft, type DraftState, draftOf, EMPTY_DRAFT, promptFrame } from './promptsActions.ts';
import { deleteSavedPrompt, saveSavedPrompt } from './promptsApi.ts';

/**
 * The prompt picker, opened from the activity dock.
 *
 * DESIGN PATTERNS:
 * - Picking sends. A saved prompt is a message the reader already wrote, so the
 *   primary action submits it to the focused session and closes the dialog.
 * - Managing is secondary and lives in the same dialog, because a library with
 *   no way to fix an entry is a library nobody trusts.
 * - This file is chrome and state; the rows are PromptPickerList.
 *
 * AVOID:
 * - Sending with no session focused. There would be nowhere for it to land.
 */

const NO_SESSION = 'Focus a session first: a prompt has to be sent somewhere.';

export interface PromptsDialogProps {
  open: boolean;
  prompts: readonly SavedPromptView[];
  sessionId: string | null;
  onOpenChange: (open: boolean) => void;
  onSend: SessionFrameSender;
}

export function PromptsDialog({ open, prompts, sessionId, onOpenChange, onSend }: PromptsDialogProps) {
  const [filter, setFilter] = useState('');
  const [draft, setDraft] = useState<DraftState | undefined>(undefined);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const send = (prompt: SavedPromptView): void => {
    if (sessionId === null) {
      setError(NO_SESSION);
      return;
    }
    onSend(sessionId, promptFrame(prompt.text));
    onOpenChange(false);
  };

  const runMutation = async (mutation: Promise<{ error: string } | undefined>): Promise<void> => {
    setBusy(true);
    const failure = await mutation;
    setBusy(false);
    if (failure) {
      setError(failure.error);
      return;
    }
    setDraft(undefined);
    // The activity section reloads the library whenever this dialog closes.
    onOpenChange(false);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent data-testid="prompts-dialog">
        <DialogHeader>
          <DialogTitle>prompts</DialogTitle>
          <DialogDescription>pick one to send it to this session</DialogDescription>
        </DialogHeader>

        <DialogBody>
          <PromptPickerList
            prompts={prompts}
            filter={filter}
            draft={draft}
            busy={busy}
            error={error}
            onFilterChange={setFilter}
            onSend={send}
            onEdit={(prompt) => setDraft(draftOf(prompt))}
            onDelete={(name) => void runMutation(deleteSavedPrompt(name, sessionId))}
            onDraftChange={setDraft}
            onSave={() =>
              void runMutation(
                draft
                  ? commitDraft(draft, {
                      save: (name, text) => saveSavedPrompt(name, text, sessionId),
                      remove: (name) => deleteSavedPrompt(name, sessionId),
                    })
                  : Promise.resolve(undefined),
              )
            }
            onCancelDraft={() => setDraft(undefined)}
          />
        </DialogBody>

        <DialogFooter>
          <Button
            variant="ghost"
            size="xs"
            className="text-[9px]"
            data-testid="prompts-new"
            disabled={busy}
            onClick={() => setDraft(EMPTY_DRAFT)}
          >
            new
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
