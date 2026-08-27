import { Button, Markdown, Textarea } from '@agimon-ai/doompi-web-components';
import type { TransientTab, WebPluginSlotProps } from '@agimon-ai/doompi-web-contracts';
import { useEffect, useState } from 'react';
import { PLAN_STATUS_KEY, type PlanDetailView } from '../src/types/planApi.ts';
import { fetchPlan, savePlan } from './planApi.ts';

/**
 * The plan's tab: what the agent decided, and what the reader wants changed.
 *
 * Two views over the same file. A plan is read, not diffed, so preview is
 * where it opens; source is where a reader corrects a step themselves rather
 * than spending a turn asking for it. The save goes to the plan file the
 * session recorded, and the next turn reads that file, so a correction made
 * here is the plan the agent implements.
 *
 * The tab is transient: it belongs to the session and the page, and closing it
 * is how it ends. It refetches whenever the session republishes its plan
 * status, which is what a rewrite by the agent looks like from here.
 */

type View = 'preview' | 'source';

/** One tab per session; the plan is singular, so the id needs nothing else. */
export const PLAN_TAB_ID = 'plan-document';

export function PlanPanel({ sessionId, statuses, closeTransientTab }: WebPluginSlotProps) {
  const [detail, setDetail] = useState<PlanDetailView | undefined>(undefined);
  const [error, setError] = useState<string | undefined>(undefined);
  const [loading, setLoading] = useState(false);
  const [view, setView] = useState<View>('preview');
  const [draft, setDraft] = useState<string | undefined>(undefined);
  const [saving, setSaving] = useState(false);
  const [saveNote, setSaveNote] = useState<string | undefined>(undefined);

  // One fetch per open, and again whenever the session republishes the status:
  // its stamp changes on every write, which is the cheapest signal that the
  // agent has revised the plan under the reader.
  const revision = statuses[PLAN_STATUS_KEY] ?? '';
  useEffect(() => {
    if (sessionId === null) return;
    let cancelled = false;
    setLoading(true);
    void fetchPlan(sessionId).then((result) => {
      if (cancelled) return;
      setLoading(false);
      if (result.ok) {
        setDetail(result.detail);
        setError(undefined);
        // A rewrite invalidates an unsaved edit's baseline, so the editor goes
        // back to what is on disk rather than offering a save that must fail.
        setDraft(undefined);
        setSaveNote(undefined);
        return;
      }
      setDetail(undefined);
      setError(result.error);
    });
    return () => {
      cancelled = true;
    };
  }, [sessionId, revision]);

  const content = draft ?? detail?.content ?? '';

  const save = async (): Promise<void> => {
    if (sessionId === null || detail === undefined || draft === undefined) return;
    setSaving(true);
    const result = await savePlan(sessionId, detail.hash, draft);
    setSaving(false);
    if (result.ok) {
      setSaveNote('saved');
      setDraft(undefined);
      const refreshed = await fetchPlan(sessionId);
      if (refreshed.ok) setDetail(refreshed.detail);
      else setError(refreshed.error);
      return;
    }
    setSaveNote(result.error);
  };

  return (
    <div data-testid="plan-panel" className="flex min-h-0 flex-1 flex-col">
      <header className="flex shrink-0 items-center gap-2 border-b border-doom-border px-4 py-2">
        <span data-testid="plan-title" className="min-w-0 flex-1 truncate text-[12px] font-bold text-doom-hi">
          {detail?.title ?? 'plan'}
        </span>
        <nav className="flex shrink-0 items-center gap-1">
          {(['preview', 'source'] as View[]).map((entry) => (
            <Button
              key={entry}
              variant={view === entry ? 'outline' : 'ghost'}
              size="xs"
              data-testid={`plan-view-${entry}`}
              onClick={() => setView(entry)}
              className="text-[9px]"
            >
              {entry}
            </Button>
          ))}
        </nav>
        <Button
          variant="ghost"
          size="xs"
          data-testid="plan-close"
          onClick={() => closeTransientTab(PLAN_TAB_ID)}
          className="shrink-0 text-[9px]"
        >
          close
        </Button>
      </header>

      {loading && detail === undefined ? (
        <p data-testid="plan-loading" className="px-4 py-3 text-[11px] text-doom-faint">
          reading this session's plan…
        </p>
      ) : null}
      {error === undefined ? null : (
        <p data-testid="plan-error" className="px-4 py-3 text-[11px] text-doom-red">
          {error}
        </p>
      )}

      <div className="min-h-0 flex-1 overflow-y-auto">
        {detail === undefined ? null : detail.unavailable ? (
          <p data-testid="plan-unavailable" className="px-4 py-3 text-[11px] text-doom-faint">
            {detail.reason ?? 'this plan cannot be shown'}
          </p>
        ) : view === 'preview' ? (
          <div data-testid="plan-preview" className="flex flex-col gap-2 p-4 text-[12px] text-doom-text">
            <Markdown text={content} />
          </div>
        ) : (
          <div className="flex flex-col gap-2 p-3">
            <Textarea
              data-testid="plan-source"
              value={content}
              spellCheck={false}
              rows={24}
              onChange={(event) => setDraft(event.target.value)}
              className="min-h-[24rem] font-mono text-[11px] leading-[1.5]"
            />
            <div className="flex items-center gap-2">
              <Button
                variant="outline"
                size="xs"
                data-testid="plan-save"
                loading={saving}
                disabled={draft === undefined || saving}
                onClick={() => void save()}
                className="text-[9px]"
              >
                save to disk
              </Button>
              {draft === undefined ? null : (
                <Button
                  variant="ghost"
                  size="xs"
                  data-testid="plan-revert"
                  onClick={() => setDraft(undefined)}
                  className="text-[9px]"
                >
                  discard edits
                </Button>
              )}
              {saveNote === undefined ? null : (
                <span
                  data-testid="plan-save-note"
                  className={saveNote === 'saved' ? 'text-[9px] text-doom-green' : 'text-[9px] text-doom-red'}
                >
                  {saveNote}
                </span>
              )}
            </div>
          </div>
        )}
      </div>

      {detail === undefined ? null : (
        <footer data-testid="plan-source-path" className="shrink-0 truncate border-t border-doom-border px-4 py-1.5">
          <span className="text-[9px] text-doom-faint">{detail.path}</span>
        </footer>
      )}
    </div>
  );
}

/** The transient tab the plan opens in; opening it again only focuses it. */
export function planTab(): TransientTab {
  return { id: PLAN_TAB_ID, label: 'plan', panel: PlanPanel };
}
