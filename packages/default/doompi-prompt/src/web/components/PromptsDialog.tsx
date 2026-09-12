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
import type { SessionFrameSender } from '@agimon-ai/doompi-core/web';
import { useEffect, useState } from 'react';
import type { SavedPromptView } from '../../types/webPrompts';
import { PromptEditor } from './PromptEditor';
import { PromptPickerList } from './PromptPickerList';
import { commitDraft, type DraftState, draftOf, EMPTY_DRAFT, promptFrame } from '../lib/promptsActions';
import { deleteSavedPrompt, saveSavedPrompt } from '../api/promptsApi';

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
  loading: boolean;
  loadError: string;
  initialDraft?: DraftState;
  sessionId: string | null;
  onOpenChange: (open: boolean) => void;
  onReload: () => Promise<void>;
  onSend: SessionFrameSender;
}

type Confirmation = { kind: 'remove'; prompt: SavedPromptView } | { kind: 'replace'; name: string };

export function PromptsDialog({
  open,
  prompts,
  loading,
  loadError,
  initialDraft,
  sessionId,
  onOpenChange,
  onReload,
  onSend,
}: PromptsDialogProps) {
  const [filter, setFilter] = useState('');
  const [draft, setDraft] = useState<DraftState | undefined>(initialDraft);
  const [confirmation, setConfirmation] = useState<Confirmation | undefined>(undefined);
  const [error, setError] = useState('');

  useEffect(() => {
    if (open && initialDraft) setDraft(initialDraft);
  }, [initialDraft, open]);
  const [busy, setBusy] = useState(false);

  const resetView = (): void => {
    setFilter('');
    setDraft(undefined);
    setConfirmation(undefined);
    setError('');
  };

  const changeOpen = (next: boolean): void => {
    if (!next) resetView();
    onOpenChange(next);
  };

  const send = (prompt: SavedPromptView): void => {
    if (sessionId === null) {
      setError(NO_SESSION);
      return;
    }
    onSend(sessionId, promptFrame(prompt.text));
    changeOpen(false);
  };

  const runMutation = async (mutation: () => Promise<{ error: string } | undefined>): Promise<void> => {
    setBusy(true);
    setError('');
    const failure = await mutation();
    if (failure) {
      setBusy(false);
      setError(failure.error);
      return;
    }
    await onReload();
    setBusy(false);
    setDraft(undefined);
    setConfirmation(undefined);
  };

  const saveDraft = (): void => {
    if (!draft) return;
    const name = draft.name.trim();
    const replacesAnother = prompts.some((prompt) => prompt.name === name && prompt.name !== draft.original);
    if (replacesAnother) {
      setConfirmation({ kind: 'replace', name });
      return;
    }
    void runMutation(() =>
      commitDraft(draft, {
        save: (nextName, text) => saveSavedPrompt(nextName, text, sessionId),
        remove: (previousName) => deleteSavedPrompt(previousName, sessionId),
      }),
    );
  };

  const title =
    confirmation?.kind === 'remove'
      ? 'remove prompt'
      : confirmation?.kind === 'replace'
        ? 'replace prompt'
        : draft
          ? draft.original === ''
            ? 'new prompt'
            : 'edit prompt'
          : 'prompts';

  return (
    <Dialog open={open} onOpenChange={changeOpen}>
      <DialogContent
        data-testid="prompts-dialog"
        onOpenAutoFocus={(event) => {
          if (!initialDraft) event.preventDefault();
        }}
        aria-describedby="prompts-dialog-description"
      >
        <DialogHeader dismissible closeLabel="close prompts">
          <div className="min-w-0">
            <DialogTitle>{title}</DialogTitle>
            <DialogDescription id="prompts-dialog-description">
              {draft || confirmation ? 'manage your saved prompt library' : 'select one to send it now'}
            </DialogDescription>
          </div>
        </DialogHeader>

        <DialogBody>
          {error === '' ? null : draft || confirmation ? (
            <span className="text-sm text-doom-red" data-testid="prompts-error">
              {error}
            </span>
          ) : null}

          {confirmation?.kind === 'remove' ? (
            <div className="flex flex-col gap-4" data-testid="prompts-remove-confirmation">
              <p className="text-sm leading-relaxed text-doom-dim">
                Remove <strong className="text-doom-hi">/{confirmation.prompt.name}</strong>? This cannot be undone.
              </p>
              <div className="flex justify-end gap-2">
                <Button variant="outline" size="md" disabled={busy} onClick={() => setConfirmation(undefined)}>
                  cancel
                </Button>
                <Button
                  variant="danger"
                  size="md"
                  data-testid="prompts-remove-confirm"
                  disabled={busy}
                  onClick={() => void runMutation(() => deleteSavedPrompt(confirmation.prompt.name, sessionId))}
                >
                  {busy ? 'removing…' : 'remove prompt'}
                </Button>
              </div>
            </div>
          ) : confirmation?.kind === 'replace' && draft ? (
            <div className="flex flex-col gap-4" data-testid="prompts-replace-confirmation">
              <p className="text-sm leading-relaxed text-doom-dim">
                <strong className="text-doom-hi">/{confirmation.name}</strong> already exists. Replace its text with
                this draft?
              </p>
              <div className="flex justify-end gap-2">
                <Button variant="outline" size="md" disabled={busy} onClick={() => setConfirmation(undefined)}>
                  go back
                </Button>
                <Button
                  variant="danger"
                  size="md"
                  data-testid="prompts-replace-confirm"
                  disabled={busy}
                  onClick={() =>
                    void runMutation(() =>
                      commitDraft(draft, {
                        save: (name, text) => saveSavedPrompt(name, text, sessionId),
                        remove: (name) => deleteSavedPrompt(name, sessionId),
                      }),
                    )
                  }
                >
                  {busy ? 'replacing…' : 'replace prompt'}
                </Button>
              </div>
            </div>
          ) : draft ? (
            <PromptEditor
              draft={draft}
              busy={busy}
              onChange={setDraft}
              onSave={saveDraft}
              onCancel={() => setDraft(undefined)}
            />
          ) : (
            <PromptPickerList
              prompts={prompts}
              filter={filter}
              loading={loading}
              busy={busy}
              error={error || loadError}
              onFilterChange={setFilter}
              onSend={send}
              onEdit={(prompt) => setDraft(draftOf(prompt))}
              onDelete={(prompt) => setConfirmation({ kind: 'remove', prompt })}
              onRetry={() => void onReload()}
            />
          )}
        </DialogBody>

        {draft || confirmation ? null : (
          <DialogFooter variant="bar">
            <span className="text-xs text-doom-faint">
              {prompts.length === 0 ? 'build your reusable library' : `${String(prompts.length)} saved`}
            </span>
            <Button
              variant="outline"
              size="sm"
              data-testid="prompts-new"
              disabled={busy}
              onClick={() => setDraft(EMPTY_DRAFT)}
            >
              new prompt
            </Button>
          </DialogFooter>
        )}
      </DialogContent>
    </Dialog>
  );
}
