import { Button, Input } from '@agimon-ai/doompi-web-components';
import type { SavedPromptView } from '../../types/webPrompts.ts';
import { filterPrompts } from '../lib/promptsActions.ts';

/**
 * The list-first body of the prompt dialog.
 *
 * DESIGN PATTERNS:
 * - Sending is the row's large primary target; management actions stay visible.
 * - Loading, failure and empty states occupy the list instead of looking like a
 *   successfully loaded empty library.
 *
 * AVOID:
 * - Fetching or mutating here. The dialog owns behavior, this owns markup.
 */

export interface PromptPickerListProps {
  prompts: readonly SavedPromptView[];
  filter: string;
  loading: boolean;
  busy: boolean;
  error: string;
  onFilterChange: (filter: string) => void;
  onSend: (prompt: SavedPromptView) => void;
  onEdit: (prompt: SavedPromptView) => void;
  onDelete: (prompt: SavedPromptView) => void;
  onRetry: () => void;
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

      {props.loading ? (
        <p data-testid="prompts-loading" className="py-4 text-center text-sm text-doom-faint">
          loading prompts…
        </p>
      ) : props.error !== '' ? (
        <div className="flex items-center justify-between gap-3 rounded-md border border-doom-red/40 p-3">
          <span className="text-sm text-doom-red" data-testid="prompts-error">
            {props.error}
          </span>
          <Button variant="outline" size="sm" data-testid="prompts-retry" onClick={props.onRetry}>
            retry
          </Button>
        </div>
      ) : visible.length === 0 ? (
        <p data-testid="prompts-empty" className="py-4 text-center text-sm text-doom-faint">
          {props.prompts.length === 0 ? 'no saved prompts yet. create one below.' : 'nothing matches that filter'}
        </p>
      ) : null}

      {props.loading || props.error !== ''
        ? null
        : visible.map((prompt) => (
            <div
              key={prompt.name}
              data-testid={`prompts-item-${prompt.name}`}
              className="flex min-h-11 items-center gap-1 rounded-md border border-doom-border-soft px-2 py-1.5 text-doom-text hover:bg-doom-deep"
            >
              <Button
                variant="ghost"
                size="md"
                className="min-w-0 flex-1 flex-col items-start justify-center gap-0 px-2 text-left"
                data-testid={`prompts-send-${prompt.name}`}
                title="send this prompt to the focused session"
                onClick={() => props.onSend(prompt)}
              >
                <span className="w-full truncate text-sm font-bold">/{prompt.name}</span>
                <span className="w-full truncate text-xs font-normal text-doom-faint">{prompt.description}</span>
              </Button>
              <Button
                variant="ghost"
                size="sm"
                data-testid={`prompts-edit-${prompt.name}`}
                aria-label={`edit /${prompt.name}`}
                onClick={() => props.onEdit(prompt)}
              >
                edit
              </Button>
              <Button
                variant="ghost"
                size="sm"
                data-testid={`prompts-delete-${prompt.name}`}
                aria-label={`remove /${prompt.name}`}
                disabled={props.busy}
                onClick={() => props.onDelete(prompt)}
              >
                remove
              </Button>
            </div>
          ))}
    </div>
  );
}
