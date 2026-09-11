import type { ToolPromptRenderProps } from '@agimon-ai/doompi-web-contracts';
import { useEffect } from 'react';
import { ToolRendererBoundary } from '../../components/ToolRendererBoundary.tsx';
import type { ToolPromptClaim } from '../../lib/toolPrompt.ts';
import { toolMessageProps } from '../../lib/toolMessageProps.ts';
import { answerDialogValue, cancelDialog, useActiveSession } from '../../stores/sessionStore.ts';
import { markToolPromptFailed } from '../../stores/toolPromptStore.ts';
import { usePluginSlotProps } from '../../stores/usePluginSlotProps.ts';

/**
 * Hands the request back after a prompt threw. Rendered rather than called,
 * because the boundary reports the failure during a render and the store may
 * only be written after it, in an effect.
 */
function PromptSurrendered({ dialogId }: { dialogId: string }) {
  useEffect(() => markToolPromptFailed(dialogId), [dialogId]);
  return null;
}

/**
 * The composer's stand-in while a running tool holds the agent's question.
 *
 * The plugin owns everything inside; the host only binds the two ways to
 * settle the request and catches a throw. A renderer that fails gives the
 * request up rather than leaving the reader with the only surface that could
 * answer it showing nothing, and the host's dialog opens on the next frame.
 */
export function ComposerPrompt({ claim, sessionId }: { claim: ToolPromptClaim; sessionId: string | null }) {
  const statuses = useActiveSession((state) => state.statuses);
  const slotProps = usePluginSlotProps(sessionId);
  const props: ToolPromptRenderProps = {
    ...toolMessageProps(slotProps, claim.entry, statuses),
    dialog: claim.dialog,
    answer: (value) => answerDialogValue(claim.dialog.id, value),
    cancel: () => cancelDialog(claim.dialog.id),
  };
  return (
    <ToolRendererBoundary key={claim.dialog.id} toolName={claim.entry.name}>
      {(failed) =>
        failed ? (
          <PromptSurrendered dialogId={claim.dialog.id} />
        ) : (
          <div data-testid="composer-prompt" data-tool-name={claim.entry.name}>
            <claim.prompt.component {...props} />
          </div>
        )
      }
    </ToolRendererBoundary>
  );
}
