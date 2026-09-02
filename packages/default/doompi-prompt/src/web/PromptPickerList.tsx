import { Button, Input } from '@agimon-ai/doompi-web-components';
import type { SavedPromptView } from '../types/webPrompts.ts';
import { PromptEditor } from './PromptEditor.tsx';
import type { DraftState } from './promptsActions.ts';
import { filterPrompts } from './promptsActions.ts';

/**
 * The body of the prompt dialog: filter, rows, and the editor when one is open.
 *
 * DESIGN PATTERNS:
 * - Presentational and outside the dialog chrome, so it renders without a DOM
 *   portal and the tests can see it.
 * - Sending is the row's primary action; managing sits to its right.
 *
 * AVOID:
 * - Fetching here. The dialog owns the calls, this owns the markup.
 */

export interface PromptPickerListProps {
  prompts: readonly SavedPromptView[];
  filter: string;
  draft: DraftState | undefined;
  busy: boolean;
  error: string;
  onFilterChange: (filter: string) => void;
  onSend: (prompt: SavedPromptView) => void;
  onEdit: (prompt: SavedPromptView) => void;
  onDelete: (name: string) => void;
  onDraftChange: (draft: DraftState) => void;
  onSave: () => void;
  onCancelDraft: () => void;
}

export function PromptPickerList(props: PromptPickerListProps) {
  const visible = filterPrompts(props.prompts, props.filter);

  return (
    <div data-testid="prompts-picker" className="flex flex-col gap-2">
      <Input
        data-testid="prompts-filter"
        value={props.filter}
        placeholder="filter"
        onChange={(event) => props.onFilterChange(event.target.value)}
      />

      {props.error === '' ? null : (
        <span className="text-[10px] text-doom-red" data-testid="prompts-error">
          {props.error}
        </span>
      )}

      {visible.length === 0 ? (
        <p data-testid="prompts-empty" className="text-[11px] text-doom-faint">
          {props.prompts.length === 0 ? 'no saved prompts yet' : 'nothing matches that filter'}
        </p>
      ) : null}

      {visible.map((prompt) => (
        <div
          key={prompt.name}
          data-testid={`prompts-item-${prompt.name}`}
          className="flex items-center gap-2 rounded-[5px] px-2 py-1 text-[11px] text-doom-text hover:bg-doom-panel"
        >
          <Button
            variant="ghost"
            size="xs"
            className="min-w-0 flex-1 justify-start text-left text-[11px]"
            data-testid={`prompts-send-${prompt.name}`}
            title="send this prompt to the focused session"
            onClick={() => props.onSend(prompt)}
          >
            <span className="min-w-0 flex-1 truncate font-bold">/{prompt.name}</span>
            <span className="min-w-0 flex-1 truncate text-[9px] text-doom-faint">{prompt.description}</span>
          </Button>
          <Button
            variant="ghost"
            size="xs"
            className="text-[9px]"
            data-testid={`prompts-edit-${prompt.name}`}
            onClick={() => props.onEdit(prompt)}
          >
            edit
          </Button>
          <Button
            variant="ghost"
            size="xs"
            className="text-[9px]"
            data-testid={`prompts-delete-${prompt.name}`}
            disabled={props.busy}
            onClick={() => props.onDelete(prompt.name)}
          >
            delete
          </Button>
        </div>
      ))}

      {props.draft === undefined ? null : (
        <PromptEditor
          draft={props.draft}
          busy={props.busy}
          onChange={props.onDraftChange}
          onSave={props.onSave}
          onCancel={props.onCancelDraft}
        />
      )}
    </div>
  );
}
