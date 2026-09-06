import { Button } from '@agimon-ai/doompi-web-components';
import type { WebPluginSlotProps } from '@agimon-ai/doompi-web-contracts';
import { useCallback, useEffect, useState } from 'react';
import type { SavedPromptView } from '../../types/webPrompts.ts';
import { PromptsDialog } from './PromptsDialog.tsx';
import { fetchSavedPrompts } from '../api/promptsApi.ts';
import { subscribeMessagePromptDraft } from '../lib/messagePromptDraft.ts';
import type { DraftState } from '../lib/promptsActions.ts';

/**
 * The prompts group's body in the activity dock.
 *
 * DESIGN PATTERNS:
 * - One line and one action, like the agents and workflows groups: the dock is
 *   a status surface, so the library itself opens in a dialog over the
 *   conversation rather than pushing the reader into another page.
 * - The library loads on mount, again on open, and after every mutation so the
 *   visible list is never an aborted or stale snapshot.
 *
 * AVOID:
 * - Rendering the library here. A dock group is a summary.
 */

export function PromptsActivitySection({ sessionId, sendSessionFrame }: WebPluginSlotProps) {
  const [prompts, setPrompts] = useState<readonly SavedPromptView[]>([]);
  const [open, setOpen] = useState(false);
  const [initialDraft, setInitialDraft] = useState<DraftState | undefined>(undefined);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);

  const loadPrompts = useCallback(
    async (signal?: AbortSignal): Promise<void> => {
      setLoading(true);
      const result = await fetchSavedPrompts(signal, sessionId);
      if (signal?.aborted) return;
      if ('error' in result) setError(result.error);
      else {
        setError('');
        setPrompts(result.prompts);
      }
      setLoading(false);
    },
    [sessionId],
  );

  useEffect(() => {
    const controller = new AbortController();
    void loadPrompts(controller.signal);
    return () => controller.abort();
  }, [loadPrompts, open]);

  useEffect(
    () =>
      subscribeMessagePromptDraft((draft) => {
        setInitialDraft(draft);
        setOpen(true);
      }),
    [],
  );

  const changeOpen = (next: boolean): void => {
    if (!next) setInitialDraft(undefined);
    setOpen(next);
  };

  const summary =
    error !== '' ? error : loading ? 'loading' : prompts.length === 0 ? 'idle' : `${String(prompts.length)} saved`;

  return (
    <div data-testid="activity-section-prompts" className="flex flex-col gap-0.5">
      <div className="flex items-center gap-2 px-1">
        <p data-testid="activity-summary-prompts" className="text-[10px] text-doom-faint">
          {summary}
        </p>
        <Button
          variant="link"
          size="xs"
          data-testid="activity-prompts-open"
          className="px-0"
          onClick={() => {
            setInitialDraft(undefined);
            setOpen(true);
          }}
        >
          send a prompt
        </Button>
      </div>

      <PromptsDialog
        open={open}
        prompts={prompts}
        loading={loading}
        loadError={error}
        initialDraft={initialDraft}
        sessionId={sessionId}
        onOpenChange={changeOpen}
        onReload={loadPrompts}
        onSend={sendSessionFrame}
      />
    </div>
  );
}
