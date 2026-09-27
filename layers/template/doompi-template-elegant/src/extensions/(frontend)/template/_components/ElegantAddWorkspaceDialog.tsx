import type { WebTemplateRailActions } from '@agimon-ai/doompi-core/web';
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

import { ElegantFolderBrowser } from './ElegantFolderBrowser';

const SUGGESTION_DEBOUNCE_MS = 120;
const NO_HIGHLIGHT = -1;
const TRAILING_SEPARATORS = /\/+$/u;

function folderName(path: string): string {
  const trimmed = path.trim().replace(TRAILING_SEPARATORS, '');
  return trimmed.slice(trimmed.lastIndexOf('/') + 1);
}

/** Adds a workspace by name, by folder, or both; a name alone gets a new default folder. */
export function ElegantAddWorkspaceDialog({
  suggestedPaths,
  actions,
}: {
  suggestedPaths: readonly string[];
  actions: WebTemplateRailActions;
}) {
  const [name, setName] = useState('');
  // The name follows the folder until the user types their own.
  const [nameEdited, setNameEdited] = useState(false);
  const [path, setPath] = useState(suggestedPaths[0] ?? '');
  const [browsing, setBrowsing] = useState(false);
  const [suggestions, setSuggestions] = useState<readonly string[]>([]);
  const [highlight, setHighlight] = useState(NO_HIGHLIGHT);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const pathInput = useRef<HTMLInputElement>(null);
  const shownName = nameEdited ? name : folderName(path);

  useEffect(() => {
    const typed = path.trim();
    if (typed === '') return;
    let stale = false;
    const timer = setTimeout(async () => {
      const found = await actions.searchDirectories(typed);
      if (stale) return;
      setSuggestions(found.filter((directory) => directory !== typed));
      setHighlight(NO_HIGHLIGHT);
    }, SUGGESTION_DEBOUNCE_MS);
    return () => {
      stale = true;
      clearTimeout(timer);
    };
  }, [path, actions]);

  const changePath = (next: string): void => {
    setPath(next);
    if (next.trim() === '') setSuggestions([]);
  };
  const pick = (directory: string): void => {
    changePath(`${directory}/`);
    pathInput.current?.focus();
  };
  const trimmedPath = path.trim().replace(TRAILING_SEPARATORS, '') || (path.trim() === '' ? '' : '/');
  const canSubmit = !busy && (trimmedPath !== '' || shownName.trim() !== '');
  const submit = async (): Promise<void> => {
    if (!canSubmit) return;
    setBusy(true);
    setError('');
    const result = await actions.addWorkspace({
      name: shownName.trim(),
      ...(trimmedPath === '' ? {} : { path: trimmedPath }),
    });
    setBusy(false);
    if (result !== undefined) setError(result.error);
  };

  return (
    <Dialog open onOpenChange={(next) => !next && !busy && actions.closeAddWorkspace()}>
      <DialogContent width="md" data-testid="add-workspace-dialog" aria-describedby={undefined}>
        <DialogHeader>
          <DialogTitle>add workspace</DialogTitle>
        </DialogHeader>
        <DialogBody>
          <label htmlFor="add-workspace-name" className="flex flex-col gap-1">
            <span className="text-xs text-doom-faint">name</span>
            <Input
              id="add-workspace-name"
              data-testid="add-workspace-name"
              value={shownName}
              autoFocus
              onChange={(event) => {
                setNameEdited(true);
                setName(event.target.value);
              }}
              onKeyDown={(event) => {
                if (event.key === 'Enter') void submit();
              }}
              placeholder="my-project"
            />
          </label>
          <label htmlFor="add-workspace-root" className="flex flex-col gap-1">
            <span className="text-xs text-doom-faint">
              folder <span className="text-doom-faint">(optional; type a path or browse)</span>
            </span>
            <span className="flex items-center gap-1.5">
              <Input
                id="add-workspace-root"
                ref={pathInput}
                data-testid="add-workspace-root"
                value={path}
                onChange={(event) => changePath(event.target.value)}
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
                placeholder="~/workspace/my-project"
                className="min-w-0 flex-1"
              />
              <Button
                variant={browsing ? 'subtle' : 'outline'}
                size="md"
                data-testid="add-workspace-browse"
                aria-pressed={browsing}
                onClick={() => setBrowsing((open) => !open)}
              >
                browse
              </Button>
            </span>
          </label>
          {browsing ? (
            <ElegantFolderBrowser
              {...(trimmedPath.startsWith('/') ? { start: trimmedPath } : {})}
              listDirectory={actions.listDirectory}
              onSelect={(selected) => {
                changePath(selected);
                setBrowsing(false);
              }}
            />
          ) : suggestions.length > 0 ? (
            <div
              role="listbox"
              aria-label="matching directories"
              data-testid="add-workspace-suggestions"
              className="max-h-40 overflow-y-auto rounded-lg border border-doom-border-soft bg-doom-panel/40 p-1.5"
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
          {suggestedPaths.length > 0 ? (
            <div className="flex flex-wrap gap-1">
              {suggestedPaths.slice(0, 4).map((suggested) => (
                <Button key={suggested} variant="outline" size="xs" onClick={() => changePath(suggested)}>
                  {suggested}
                </Button>
              ))}
            </div>
          ) : null}
          {trimmedPath === '' && shownName.trim() !== '' ? (
            <p data-testid="add-workspace-default-hint" className="text-xs text-doom-faint">
              creates ~/.pi/.doom/workspace/{shownName.trim()}
            </p>
          ) : null}
          {error ? (
            <pre className="max-h-28 overflow-y-auto rounded border border-doom-edge-red bg-doom-tint-red/40 px-2.5 py-2 text-xs whitespace-pre-wrap text-doom-red">
              {error}
            </pre>
          ) : null}
          <DialogFooter>
            <Button variant="outline" onClick={() => actions.closeAddWorkspace()} disabled={busy}>
              cancel
            </Button>
            <Button
              variant="primary"
              data-testid="add-workspace-confirm"
              onClick={() => void submit()}
              disabled={!canSubmit}
            >
              {busy ? 'adding…' : 'add workspace'}
            </Button>
          </DialogFooter>
        </DialogBody>
      </DialogContent>
    </Dialog>
  );
}
