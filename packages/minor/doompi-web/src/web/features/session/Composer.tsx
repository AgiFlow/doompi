import { useCallback, useEffect, useRef, useState } from 'react';
import { searchSessionFiles } from '../../lib/hubApi.ts';
import { abortRun, queueFollowUp, submitMessage, useActiveSession } from '../../stores/sessionStore.ts';
import { activeSessionId, useActiveSessionMeta } from '../../stores/sessionsStore.ts';

/** The input grows with the draft up to this many pixels, then scrolls. */
const MAX_INPUT_HEIGHT_PX = 192;
const MAX_COMPLETION_ITEMS = 8;
const FILE_SEARCH_DEBOUNCE_MS = 150;

interface CompletionItem {
  /** What replaces the trigger token when accepted. */
  insert: string;
  label: string;
  detail?: string;
}

interface CompletionState {
  kind: 'command' | 'file';
  /** Index of the trigger character in the draft. */
  tokenStart: number;
  query: string;
  items: CompletionItem[];
  selected: number;
}

/** The /command or @file token the caret sits in, or null when there is none. */
function triggerTokenAt(
  draft: string,
  caret: number,
): { kind: 'command' | 'file'; start: number; query: string } | null {
  const before = draft.slice(0, caret);
  const start = Math.max(before.lastIndexOf(' '), before.lastIndexOf('\n')) + 1;
  const token = before.slice(start);
  if (token.startsWith('/') && start === 0) return { kind: 'command', start, query: token.slice(1) };
  if (token.startsWith('@') && token.length <= 64) return { kind: 'file', start, query: token.slice(1) };
  return null;
}

export function Composer() {
  const meta = useActiveSessionMeta();
  const streaming = useActiveSession((state) => state.streaming);
  const commands = useActiveSession((state) => state.commands);
  const [draft, setDraft] = useState('');
  const [caret, setCaret] = useState(0);
  const [dismissedToken, setDismissedToken] = useState<number | null>(null);
  const [completion, setCompletion] = useState<CompletionState | null>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const searchTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  const attached = meta?.attach === 'attached';
  const queued = meta?.summary.pendingMessageCount ?? 0;

  // Auto-grow: measure after every draft change so pasted stack traces are
  // actually visible instead of scrolling inside one line.
  const resize = useCallback((): void => {
    const input = inputRef.current;
    if (!input) return;
    input.style.height = 'auto';
    input.style.height = `${String(Math.min(input.scrollHeight, MAX_INPUT_HEIGHT_PX))}px`;
  }, []);
  useEffect(() => resize(), [draft, resize]);

  const closeCompletion = useCallback((): void => {
    if (searchTimer.current) clearTimeout(searchTimer.current);
    setCompletion(null);
  }, []);

  /** Esc dismisses the popup for the token being typed; edits re-arm it. */
  const dismissCompletion = useCallback((): void => {
    const trigger = triggerTokenAt(draft, caret);
    setDismissedToken(trigger?.start ?? null);
    closeCompletion();
  }, [draft, caret, closeCompletion]);

  // The popup is derived state: any change to the draft, caret, session
  // commands, or attachment recomputes it, so data arriving after a keystroke
  // still opens it.
  useEffect(() => {
    const trigger = triggerTokenAt(draft, caret);
    if (!trigger || !attached || dismissedToken === trigger.start) {
      closeCompletion();
      return;
    }
    if (trigger.kind === 'command') {
      const items = commands
        .filter((command) => command.name.toLowerCase().startsWith(trigger.query.toLowerCase()))
        .slice(0, MAX_COMPLETION_ITEMS)
        .map((command) => ({ insert: `/${command.name} `, label: `/${command.name}`, detail: command.description }));
      setCompletion(
        items.length > 0
          ? { kind: 'command', tokenStart: trigger.start, query: trigger.query, items, selected: 0 }
          : null,
      );
      return;
    }
    if (searchTimer.current) clearTimeout(searchTimer.current);
    searchTimer.current = setTimeout(() => {
      const sessionId = activeSessionId();
      if (sessionId === null) return;
      void searchSessionFiles(sessionId, trigger.query).then((files) => {
        // The draft may have moved on while the lookup ran.
        const input = inputRef.current;
        if (!input || triggerTokenAt(input.value, input.selectionStart)?.query !== trigger.query) return;
        const items = files.slice(0, MAX_COMPLETION_ITEMS).map((file) => ({ insert: `@${file} `, label: `@${file}` }));
        setCompletion(
          items.length > 0
            ? { kind: 'file', tokenStart: trigger.start, query: trigger.query, items, selected: 0 }
            : null,
        );
      });
    }, FILE_SEARCH_DEBOUNCE_MS);
    return () => {
      if (searchTimer.current) clearTimeout(searchTimer.current);
    };
  }, [draft, caret, commands, attached, dismissedToken, closeCompletion]);

  // Clicking anywhere outside the composer closes the popup.
  useEffect(() => {
    if (!completion) return;
    const onPointerDown = (event: MouseEvent): void => {
      if (containerRef.current && event.target instanceof Node && !containerRef.current.contains(event.target)) {
        closeCompletion();
      }
    };
    document.addEventListener('mousedown', onPointerDown);
    return () => document.removeEventListener('mousedown', onPointerDown);
  }, [completion, closeCompletion]);

  const accept = (state: CompletionState, index: number): void => {
    const item = state.items[index];
    if (!item) return;
    const next = draft.slice(0, state.tokenStart) + item.insert + draft.slice(caret);
    setDraft(next);
    const position = state.tokenStart + item.insert.length;
    setCaret(position);
    setDismissedToken(state.tokenStart);
    requestAnimationFrame(() => {
      inputRef.current?.focus();
      inputRef.current?.setSelectionRange(position, position);
    });
  };

  const submit = (): void => {
    if (!draft.trim() || !attached) return;
    submitMessage(draft);
    setDraft('');
    setCaret(0);
    setDismissedToken(null);
    closeCompletion();
  };

  const queue = (): void => {
    if (!draft.trim() || !attached) return;
    queueFollowUp(draft);
    setDraft('');
    setCaret(0);
    setDismissedToken(null);
    closeCompletion();
  };

  const placeholder = !attached
    ? 'waiting for the session…'
    : streaming
      ? 'steer the run without stopping it…'
      : 'ask anything · / for commands · @ for files…';

  return (
    <div className="shrink-0 border-t border-doom-border bg-doom-rail px-5 pt-3 pb-2.5">
      <div
        ref={containerRef}
        className="relative rounded-lg border border-doom-border bg-doom-deep transition-colors focus-within:border-doom-blue/60"
      >
        {completion ? (
          <div
            data-testid="composer-completion"
            className="absolute bottom-full left-3 z-30 mb-2 w-[420px] max-w-[85%] overflow-hidden rounded-md border border-doom-border bg-doom-panel shadow-xl"
          >
            {completion.items.map((item, index) => (
              <button
                key={item.label}
                type="button"
                data-testid={`composer-completion-item-${String(index)}`}
                onMouseEnter={() => setCompletion({ ...completion, selected: index })}
                onMouseDown={(event) => {
                  event.preventDefault();
                  accept(completion, index);
                }}
                className={`flex w-full items-baseline gap-2.5 px-3 py-1.5 text-left ${
                  index === completion.selected ? 'bg-doom-blue/15' : ''
                }`}
              >
                <span className="shrink-0 text-[12px] font-bold text-doom-blue">{item.label}</span>
                {item.detail ? <span className="truncate text-[10px] text-doom-dim">{item.detail}</span> : null}
              </button>
            ))}
            <p className="border-t border-doom-border-soft px-3 py-1 text-[9px] text-doom-faint">
              tab or enter completes · esc closes
            </p>
          </div>
        ) : null}
        <div className="flex items-start gap-2.5 px-3.5 pt-3">
          <span className="mt-[3px] shrink-0 select-none text-[13px] leading-none text-doom-green">&gt;</span>
          <textarea
            ref={inputRef}
            data-testid="composer-input"
            value={draft}
            disabled={!attached}
            onChange={(event) => {
              setDraft(event.target.value);
              setCaret(event.target.selectionStart);
              setDismissedToken(null);
            }}
            onClick={(event) => setCaret(event.currentTarget.selectionStart)}
            onKeyUp={(event) => setCaret(event.currentTarget.selectionStart)}
            onKeyDown={(event) => {
              if (completion) {
                if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
                  event.preventDefault();
                  const delta = event.key === 'ArrowDown' ? 1 : -1;
                  const count = completion.items.length;
                  setCompletion({ ...completion, selected: (completion.selected + delta + count) % count });
                  return;
                }
                if (event.key === 'Tab' || event.key === 'Enter') {
                  event.preventDefault();
                  accept(completion, completion.selected);
                  return;
                }
                if (event.key === 'Escape') {
                  event.preventDefault();
                  dismissCompletion();
                  return;
                }
              }
              if (event.key === 'Enter' && !event.shiftKey) {
                event.preventDefault();
                submit();
              }
              if (event.key === 'Escape' && streaming) {
                event.preventDefault();
                abortRun();
              }
            }}
            rows={1}
            placeholder={placeholder}
            className="min-h-[20px] min-w-0 flex-1 resize-none bg-transparent text-[13px] leading-relaxed text-doom-hi outline-none placeholder:text-doom-faint disabled:opacity-50"
          />
        </div>
        <div className="flex items-center gap-2 px-3.5 pt-2 pb-2.5">
          <span data-testid="composer-hint" className="text-[10px] text-doom-faint">
            {streaming ? 'enter steers the run · esc aborts' : 'enter sends · shift+enter for a new line'}
          </span>
          {queued > 0 ? (
            <span
              data-testid="composer-queued"
              className="rounded-full bg-doom-panel px-2 py-0.5 text-[9px] font-bold text-doom-dim"
            >
              {queued} queued
            </span>
          ) : null}
          <span className="min-w-0 flex-1" />
          {streaming ? (
            <button
              type="button"
              data-testid="composer-abort"
              onClick={() => abortRun()}
              className="flex h-7 shrink-0 items-center gap-1.5 rounded-md border border-[#6B3A3A] bg-[#332428] px-3 text-[11px] font-bold text-doom-red hover:bg-[#3d2b30]"
            >
              <span className="inline-block h-[7px] w-[7px] bg-doom-red" />
              abort
            </button>
          ) : null}
          <button
            type="button"
            data-testid="composer-queue"
            onClick={queue}
            disabled={!attached || !draft.trim()}
            title="deliver after the current run settles"
            className="h-7 shrink-0 rounded-md border border-doom-border px-3 text-[11px] text-doom-dim hover:border-doom-blue/40 hover:text-doom-hi disabled:opacity-40"
          >
            queue
          </button>
          <button
            type="button"
            data-testid="composer-send"
            onClick={submit}
            disabled={!attached || !draft.trim()}
            className="h-7 shrink-0 rounded-md bg-doom-blue px-3.5 text-[11px] font-bold text-doom-rail hover:brightness-110 disabled:opacity-40"
          >
            {streaming ? 'steer' : 'send'}
          </button>
        </div>
      </div>
    </div>
  );
}
