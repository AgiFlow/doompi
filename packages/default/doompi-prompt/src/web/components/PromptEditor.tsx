import { Button, Input, Textarea } from '@agimon-ai/doompi-web-components';

import { canSaveDraft, type DraftState } from '../lib/promptsActions';

/**
 * The create and edit form for one saved prompt.
 *
 * DESIGN PATTERNS:
 * - Presentational: the draft and every action come from props, so the panel
 *   owns the state and this file stays a form.
 * - Save stays disabled until the draft could actually be written, which keeps
 *   the obvious mistakes off the network without duplicating the server rule.
 *
 * AVOID:
 * - Validating the name shape here. The API owns that rule and reports it.
 */

export interface PromptEditorProps {
  draft: DraftState;
  busy: boolean;
  onChange: (draft: DraftState) => void;
  onSave: () => void;
  onCancel: () => void;
}

export function PromptEditor({ draft, busy, onChange, onSave, onCancel }: PromptEditorProps) {
  const editing = draft.original !== '';
  return (
    <div data-testid="prompts-editor" className="flex flex-col gap-4">
      <div className="flex flex-col gap-1.5">
        <label htmlFor="prompts-name" className="text-xs font-bold text-doom-dim">
          prompt name
        </label>
        <Input
          id="prompts-name"
          data-testid="prompts-name"
          value={draft.name}
          placeholder="lowercase letters, digits and dashes"
          autoComplete="off"
          autoFocus
          onChange={(event) => onChange({ ...draft, name: event.target.value })}
        />
      </div>
      <div className="flex flex-col gap-1.5">
        <label htmlFor="prompts-text" className="text-xs font-bold text-doom-dim">
          prompt text
        </label>
        <Textarea
          id="prompts-text"
          data-testid="prompts-text"
          rows={10}
          value={draft.text}
          placeholder="the prompt text"
          onChange={(event) => onChange({ ...draft, text: event.target.value })}
        />
      </div>
      <div className="flex items-center justify-end gap-2">
        <Button variant="outline" size="md" data-testid="prompts-cancel" disabled={busy} onClick={onCancel}>
          cancel
        </Button>
        <Button size="md" data-testid="prompts-save" disabled={busy || !canSaveDraft(draft)} onClick={onSave}>
          {busy ? 'saving…' : editing ? 'save changes' : 'save prompt'}
        </Button>
      </div>
    </div>
  );
}
