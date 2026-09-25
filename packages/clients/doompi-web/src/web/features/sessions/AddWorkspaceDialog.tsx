import {
  Button,
  Dialog,
  DialogBody,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  Input,
  OptionRow,
} from '@agimon-ai/doompi-web-components';
import { useEffect, useRef, useState } from 'react';

import { admitWorkspace, searchDirectories } from '../../lib/hubApi';
import { applyWorkspaceUpsert, selectWorkspace } from '../../stores/workspacesStore';

const PATH_SEPARATOR = '/';
const SUGGESTION_DEBOUNCE_MS = 120;
const NO_HIGHLIGHT = -1;
const TRAILING_SEPARATORS = /\/+$/;

/** Admits a server-side folder as a durable workspace without starting an agent. */
export function AddWorkspaceDialog({
  onClose,
  suggestedRoots = [],
}: {
  onClose: () => void;
  suggestedRoots?: readonly string[];
}) {
  const [root, setRoot] = useState(suggestedRoots[0] ?? '');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [suggestions, setSuggestions] = useState<string[]>([]);
  const [highlight, setHighlight] = useState(NO_HIGHLIGHT);
  const rootInput = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const typed = root.trim();
    if (typed === '') return;
    let stale = false;
    const timer = setTimeout(async () => {
      const found = await searchDirectories(typed);
      if (stale) return;
      setSuggestions(found.filter((directory) => directory !== typed));
      setHighlight(NO_HIGHLIGHT);
    }, SUGGESTION_DEBOUNCE_MS);
    return () => {
      stale = true;
      clearTimeout(timer);
    };
  }, [root]);

  const changeRoot = (next: string): void => {
    setRoot(next);
    if (next.trim() === '') setSuggestions([]);
  };
  const pick = (directory: string): void => {
    changeRoot(`${directory}${PATH_SEPARATOR}`);
    rootInput.current?.focus();
  };
  const submit = async (): Promise<void> => {
    const directory = root.trim().replace(TRAILING_SEPARATORS, '') || PATH_SEPARATOR;
    if (busy || root.trim() === '') return;
    setBusy(true);
    setError('');
    const outcome = await admitWorkspace(directory);
    if ('error' in outcome) {
      setError(outcome.error);
      setBusy(false);
      return;
    }
    applyWorkspaceUpsert({ workspace: outcome.workspace });
    selectWorkspace(outcome.workspace.id);
    onClose();
  };

  return (
    <Dialog open onOpenChange={(next) => !next && !busy && onClose()}>
      <DialogContent width="md" data-testid="add-workspace-dialog" aria-describedby={undefined}>
        <DialogHeader>
          <DialogTitle>add workspace</DialogTitle>
        </DialogHeader>
        <DialogBody>
          <label htmlFor="add-workspace-root" className="flex flex-col gap-1">
            <span className="text-xs text-doom-faint">
              folder <span className="text-doom-faint">(type a folder name or paste a path)</span>
            </span>
            <Input
              id="add-workspace-root"
              ref={rootInput}
              data-testid="add-workspace-root"
              value={root}
              autoFocus
              onChange={(event) => changeRoot(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'ArrowDown' && suggestions.length > 0) {
                  event.preventDefault();
                  setHighlight((current) => (current + 1) % suggestions.length);
                } else if (event.key === 'ArrowUp' && suggestions.length > 0) {
                  event.preventDefault();
                  setHighlight((current) => (current <= 0 ? suggestions.length - 1 : current - 1));
                } else if (event.key === 'Enter') {
                  const chosen = highlight === NO_HIGHLIGHT ? undefined : suggestions[highlight];
                  if (chosen === undefined) void submit();
                  else pick(chosen);
                }
              }}
              placeholder="agirepo, or /absolute/path/to/project"
            />
          </label>
          {suggestions.length > 0 ? (
            <div
              role="listbox"
              aria-label="matching directories"
              data-testid="add-workspace-suggestions"
              className="max-h-40 overflow-y-auto rounded border border-doom-border bg-doom-deep p-1"
            >
              {suggestions.map((directory, index) => (
                <OptionRow
                  key={directory}
                  density="compact"
                  active={index === highlight}
                  data-testid="add-workspace-suggestion"
                  onMouseDown={(event) => event.preventDefault()}
                  onMouseEnter={() => setHighlight(index)}
                  onClick={() => pick(directory)}
                  className="w-full px-2.5 py-1 text-sm"
                >
                  {directory}
                </OptionRow>
              ))}
            </div>
          ) : null}
          {suggestedRoots.length > 0 ? (
            <div className="flex flex-wrap gap-1">
              {suggestedRoots.slice(0, 4).map((suggested) => (
                <Button key={suggested} variant="outline" size="xs" onClick={() => changeRoot(suggested)}>
                  {suggested}
                </Button>
              ))}
            </div>
          ) : null}
          {error ? (
            <pre className="max-h-28 overflow-y-auto rounded border border-doom-edge-red bg-doom-tint-red/40 px-2.5 py-2 text-xs whitespace-pre-wrap text-doom-red">
              {error}
            </pre>
          ) : null}
          <DialogFooter>
            <Button variant="outline" onClick={onClose} disabled={busy}>
              cancel
            </Button>
            <Button
              variant="primary"
              data-testid="add-workspace-confirm"
              onClick={() => void submit()}
              disabled={busy || root.trim() === ''}
            >
              {busy ? 'adding…' : 'add workspace'}
            </Button>
          </DialogFooter>
        </DialogBody>
      </DialogContent>
    </Dialog>
  );
}
