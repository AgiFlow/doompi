import type { WebPluginSlotProps } from '@agimon-ai/doompi-core/web';
import { useCallback, useEffect, useState } from 'react';

import type { SavedPromptView } from '../../types/webPrompts';
import { fetchSavedPrompts } from '../api/promptsApi';
import { subscribePromptDialogRequest } from '../lib/messagePromptDraft';
import type { DraftState } from '../lib/promptsActions';
import { PromptsDialog } from './PromptsDialog';

/**
 * The prompt library's dialog and the state behind it.
 *
 * DESIGN PATTERNS:
 * - This fills an overlay, which the host keeps mounted for the whole page.
 *   The two ways in are both transient (a timeline action has no component at
 *   all, a composer menu entry unmounts when the menu closes), so the state
 *   they open has to live somewhere neither of them owns.
 * - Every way in arrives as one request on the package's own store, so this
 *   component has a single opening path rather than one per caller.
 * - The library loads on mount, again on open, and after every mutation so the
 *   visible list is never an aborted or stale snapshot.
 *
 * AVOID:
 * - Rendering anything while the dialog is closed. This sits in an overlay
 *   over the whole cockpit.
 * - Holding this state in the menu entry. It would be discarded on every close.
 */

export function PromptsDialogHost({ sessionId, sendSessionFrame }: WebPluginSlotProps) {
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
      subscribePromptDialogRequest((request) => {
        setInitialDraft(request.draft);
        setOpen(true);
      }),
    [],
  );

  const changeOpen = (next: boolean): void => {
    if (!next) setInitialDraft(undefined);
    setOpen(next);
  };

  return (
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
  );
}
