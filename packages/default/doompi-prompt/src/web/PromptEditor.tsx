import { Button, Input, Textarea } from '@agimon-ai/doompi-web-components';
import { canSaveDraft, type DraftState } from './promptsActions.ts';

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
  return (
    <div data-testid="prompts-editor" className="flex flex-col gap-2 rounded-[5px] border border-doom-border p-2">
      <Input
        data-testid="prompts-name"
        value={draft.name}
        placeholder="name, lowercase letters, digits and dashes"
        onChange={(event) => onChange({ ...draft, name: event.target.value })}
      />
      <Textarea
        data-testid="prompts-text"
        rows={8}
        value={draft.text}
        placeholder="the prompt text"
        onChange={(event) => onChange({ ...draft, text: event.target.value })}
      />
      <div className="flex items-center gap-2">
        <Button
          size="xs"
          className="text-[9px]"
          data-testid="prompts-save"
          disabled={busy || !canSaveDraft(draft)}
          onClick={onSave}
        >
          save
        </Button>
        <Button variant="ghost" size="xs" className="text-[9px]" data-testid="prompts-cancel" onClick={onCancel}>
          cancel
        </Button>
      </div>
    </div>
  );
}
