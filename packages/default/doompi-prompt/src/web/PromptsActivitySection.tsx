import { Button } from '@agimon-ai/doompi-web-components';
import type { WebPluginSlotProps } from '@agimon-ai/doompi-web-contracts';
import { useEffect, useState } from 'react';
import type { SavedPromptView } from '../types/webPrompts.ts';
import { PromptsDialog } from './PromptsDialog.tsx';
import { fetchSavedPrompts } from './promptsApi.ts';

/**
 * The prompts group's body in the activity dock.
 *
 * DESIGN PATTERNS:
 * - One line and one action, like the agents and workflows groups: the dock is
 *   a status surface, so the library itself opens in a dialog over the
 *   conversation rather than pushing the reader into another page.
 * - The count is read once on mount and again whenever the dialog closes,
 *   because a write inside it is the only thing that changes the number.
 *
 * AVOID:
 * - Rendering the library here. A dock group is a summary.
 */

export function PromptsActivitySection({ sessionId, sendSessionFrame }: WebPluginSlotProps) {
  const [prompts, setPrompts] = useState<readonly SavedPromptView[]>([]);
  const [open, setOpen] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    if (open) return undefined;
    const controller = new AbortController();
    void fetchSavedPrompts(controller.signal).then((result) => {
      if (controller.signal.aborted) return;
      if ('error' in result) setError(result.error);
      else {
        setError('');
        setPrompts(result.prompts);
      }
    });
    return () => controller.abort();
  }, [open]);

  const summary = error !== '' ? error : prompts.length === 0 ? 'idle' : `${String(prompts.length)} saved`;

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
          onClick={() => setOpen(true)}
        >
          send a prompt
        </Button>
      </div>

      <PromptsDialog
        open={open}
        prompts={prompts}
        sessionId={sessionId}
        onOpenChange={setOpen}
        onSend={sendSessionFrame}
      />
    </div>
  );
}
