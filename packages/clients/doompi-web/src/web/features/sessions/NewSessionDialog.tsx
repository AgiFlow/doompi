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
import { useNavigate } from '@tanstack/react-router';
import { useStore } from '@tanstack/react-store';
import { useEffect, useRef, useState } from 'react';
import { createSession, searchDirectories } from '../../lib/hubApi.ts';
import { sessionsStore, waitForSession } from '../../stores/sessionsStore.ts';

const PATH_SEPARATOR = '/';
/** Keystrokes settle for this long before the hub is asked for directories. */
const SUGGESTION_DEBOUNCE_MS = 120;
const NO_HIGHLIGHT = -1;
const TRAILING_SEPARATORS = /\/+$/;

/**
 * Creates a session the way ctrl+t promises: pick a directory, get an agent.
 *
 * The directory box completes as it is typed: the hub lists the children of
 * the parent directory whose names match the trailing segment as a regex,
 * and picking one appends a slash so the next level narrows the same way.
 * The quick-select chips combine live-session directories with paths configured
 * for the remote sandbox. The first available path also seeds an otherwise empty
 * form, which keeps a contained cockpit usable after its host sessions moved.
 */
export function NewSessionDialog({
  onClose,
  suggestedCwds = [],
}: {
  onClose: () => void;
  suggestedCwds?: readonly string[];
}) {
  const navigate = useNavigate();
  const byId = useStore(sessionsStore, (state) => state.byId);
  const activeId = useStore(sessionsStore, (state) => state.activeId);
  const [cwd, setCwd] = useState(() =>
    activeId !== null ? (byId[activeId]?.summary.cwd ?? suggestedCwds[0] ?? '') : (suggestedCwds[0] ?? ''),
  );
  const [name, setName] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [suggestions, setSuggestions] = useState<string[]>([]);
  const [highlight, setHighlight] = useState(NO_HIGHLIGHT);
  const cwdInput = useRef<HTMLInputElement>(null);

  const recentCwds = [...new Set([...Object.values(byId).map((meta) => meta.summary.cwd), ...suggestedCwds])].slice(
    0,
    4,
  );

  /** Emptying the field drops the stale matches now; the effect below only fetches. */
  const changeCwd = (next: string): void => {
    setCwd(next);
    if (next.trim() === '') setSuggestions([]);
  };

  useEffect(() => {
    const typed = cwd.trim();
    // Any typing is worth a lookup now: the hub completes a path being drilled
    // into and searches for anything else, so a bare folder name finds itself.
    if (typed === '') return;
    let stale = false;
    const timer = setTimeout(async () => {
      const found = await searchDirectories(typed);
      if (stale) return;
      // The path already typed in full is not a suggestion, only its siblings are.
      setSuggestions(found.filter((directory) => directory !== typed));
      setHighlight(NO_HIGHLIGHT);
    }, SUGGESTION_DEBOUNCE_MS);
    return () => {
      stale = true;
      clearTimeout(timer);
    };
  }, [cwd]);

  const pick = (directory: string): void => {
    changeCwd(`${directory}${PATH_SEPARATOR}`);
    cwdInput.current?.focus();
  };

  const submit = async (): Promise<void> => {
    const directory = cwd.trim().replace(TRAILING_SEPARATORS, '') || PATH_SEPARATOR;
    if (busy || !cwd.trim()) return;
    setBusy(true);
    setError('');
    const outcome = await createSession({ cwd: directory, name: name.trim() || undefined });
    if ('sessionId' in outcome) {
      // Navigating before the hub's upsert lands would bounce off the
      // unknown-session fallback; wait until the rail knows the session.
      const appeared = await waitForSession(outcome.sessionId);
      if (appeared) {
        onClose();
        await navigate({ to: '/session/$sessionId', params: { sessionId: outcome.sessionId } });
        return;
      }
      setError('The session was created but has not appeared yet; it will show up in the rail.');
      setBusy(false);
      return;
    }
    setError(outcome.error);
    setBusy(false);
  };

  const onCwdKeyDown = (event: React.KeyboardEvent<HTMLInputElement>): void => {
    if (event.key === 'ArrowDown' && suggestions.length > 0) {
      event.preventDefault();
      setHighlight((current) => (current + 1) % suggestions.length);
      return;
    }
    if (event.key === 'ArrowUp' && suggestions.length > 0) {
      event.preventDefault();
      setHighlight((current) => (current <= 0 ? suggestions.length - 1 : current - 1));
      return;
    }
    if (event.key === 'Enter') {
      const chosen = highlight === NO_HIGHLIGHT ? undefined : suggestions[highlight];
      if (chosen !== undefined) pick(chosen);
      else void submit();
    }
  };

  return (
    <Dialog
      open
      onOpenChange={(next) => {
        if (!next) onClose();
      }}
    >
      <DialogContent width="md" data-testid="new-session-dialog" aria-describedby={undefined} className="w-[440px]">
        <DialogHeader>
          <DialogTitle>new session</DialogTitle>
        </DialogHeader>
        <DialogBody>
          <label htmlFor="new-session-cwd" className="flex flex-col gap-1">
            <span className="text-[10px] text-doom-faint">
              working directory <span className="text-doom-faint/70">(type a folder name or paste a path)</span>
            </span>
            <Input
              id="new-session-cwd"
              ref={cwdInput}
              data-testid="new-session-cwd"
              value={cwd}
              autoFocus
              onChange={(event) => changeCwd(event.target.value)}
              onKeyDown={onCwdKeyDown}
              placeholder="agirepo, or /absolute/path/to/project"
            />
          </label>
          {suggestions.length > 0 ? (
            <div
              role="listbox"
              aria-label="matching directories"
              data-testid="new-session-suggestions"
              className="max-h-40 overflow-y-auto rounded border border-doom-border bg-doom-deep p-1"
            >
              {suggestions.map((directory, index) => (
                <OptionRow
                  key={directory}
                  density="compact"
                  active={index === highlight}
                  data-testid="new-session-suggestion"
                  data-highlighted={index === highlight}
                  title={directory}
                  onMouseDown={(event) => event.preventDefault()}
                  onMouseEnter={() => setHighlight(index)}
                  onClick={() => pick(directory)}
                  className="w-full px-2.5 py-1 text-[11px]"
                >
                  {directory}
                </OptionRow>
              ))}
            </div>
          ) : null}
          {recentCwds.length > 0 ? (
            <div className="flex flex-wrap gap-1">
              {recentCwds.map((recent) => (
                <Button
                  key={recent}
                  variant="outline"
                  size="xs"
                  data-testid="new-session-recent"
                  onClick={() => changeCwd(recent)}
                  className="font-normal"
                >
                  {recent}
                </Button>
              ))}
            </div>
          ) : null}
          <label htmlFor="new-session-name" className="flex flex-col gap-1">
            <span className="text-[10px] text-doom-faint">name (optional)</span>
            <Input
              id="new-session-name"
              data-testid="new-session-name"
              value={name}
              onChange={(event) => setName(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter') void submit();
              }}
              placeholder="folder name"
            />
          </label>
          {error ? (
            // A spawn failure arrives as the child's whole stderr, stack trace
            // and all. It is worth showing (it names the real cause) but not
            // worth resizing the dialog for, so it lives in its own scroller.
            <pre
              data-testid="new-session-error"
              className="max-h-28 overflow-y-auto rounded border border-doom-edge-red bg-doom-tint-red/40 px-2.5 py-2 text-[10px] leading-relaxed whitespace-pre-wrap break-words text-doom-red"
            >
              {error}
            </pre>
          ) : null}
          <DialogFooter>
            <Button variant="outline" data-testid="new-session-cancel" onClick={onClose}>
              cancel
            </Button>
            <Button
              variant="primary"
              data-testid="new-session-create"
              onClick={() => void submit()}
              disabled={busy || !cwd.trim()}
            >
              {busy ? 'creating…' : 'create'}
            </Button>
          </DialogFooter>
        </DialogBody>
      </DialogContent>
    </Dialog>
  );
}
