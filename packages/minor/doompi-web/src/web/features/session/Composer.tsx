import { useState } from 'react';
import { abortRun, queueFollowUp, submitMessage, useActiveSession } from '../../stores/sessionStore.ts';
import { useActiveSessionMeta } from '../../stores/sessionsStore.ts';

export function Composer() {
  const meta = useActiveSessionMeta();
  const streaming = useActiveSession((state) => state.streaming);
  const [draft, setDraft] = useState('');

  const attached = meta?.attach === 'attached';

  const submit = (): void => {
    if (!draft.trim() || !attached) return;
    submitMessage(draft);
    setDraft('');
  };

  const queue = (): void => {
    if (!draft.trim() || !attached) return;
    queueFollowUp(draft);
    setDraft('');
  };

  const placeholder = !attached
    ? 'waiting for the session…'
    : streaming
      ? 'steer the run without stopping it…'
      : 'ask, steer, or paste a stack trace…';

  return (
    <div className="shrink-0 border-t border-doom-border bg-doom-rail px-5 pt-3 pb-2.5">
      <div className="flex items-center gap-2.5 rounded-[7px] border border-doom-border bg-doom-deep px-[13px] py-[9px]">
        <span className="shrink-0 text-[13px] leading-none text-doom-green">&gt;</span>
        <textarea
          data-testid="composer-input"
          value={draft}
          disabled={!attached}
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={(event) => {
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
          className="min-w-0 flex-1 resize-none bg-transparent text-[13px] leading-snug text-doom-hi outline-none placeholder:text-doom-faint disabled:opacity-50"
        />
        <span data-testid="composer-hint" className="shrink-0 text-[10px] text-doom-faint">
          draft {draft.length} · {streaming ? 'esc aborts' : '^SPC leader'}
        </span>
        {streaming ? (
          <button
            type="button"
            data-testid="composer-abort"
            onClick={() => abortRun()}
            className="flex h-6 shrink-0 items-center gap-1.5 rounded border border-[#6B3A3A] bg-[#332428] px-2.5 text-[10px] font-bold text-doom-red"
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
          className="h-6 shrink-0 rounded border border-doom-border px-2.5 text-[10px] text-doom-dim hover:text-doom-hi disabled:opacity-40"
        >
          queue
        </button>
        <button
          type="button"
          data-testid="composer-send"
          onClick={submit}
          disabled={!attached || !draft.trim()}
          className="h-6 shrink-0 rounded bg-doom-blue px-2.5 text-[10px] font-bold text-doom-rail disabled:opacity-40"
        >
          {streaming ? 'steer' : 'send'}
        </button>
      </div>
    </div>
  );
}
