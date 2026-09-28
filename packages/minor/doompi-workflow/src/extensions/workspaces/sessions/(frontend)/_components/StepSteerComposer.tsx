import { Button, Textarea } from '@agimon-ai/doompi-web-components';
import { type FormEvent, useState } from 'react';

import type { WorkflowRunView } from '../../../../../types/webWorkflows';
import { steerStep } from '../_lib/terminalApi';

/**
 * Guidance for the agent a running customRun step is in, the way a Team
 * sub-agent tab steers its run: the text lands in the turn the agent is
 * working on. The caller shows it only while the step runs, since guidance
 * after the step settles would no longer shape the workflow.
 */
export function StepSteerComposer({ run, sessionId }: { run: WorkflowRunView; sessionId: string | null }) {
  const [guidance, setGuidance] = useState('');
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string>();

  const submit = async (event: FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault();
    const message = guidance.trim();
    if (message === '' || sending) return;
    setSending(true);
    setError(undefined);
    try {
      const result = await steerStep(run.workspace, run.runKey, message, sessionId);
      if ('error' in result) {
        setError(result.error);
        return;
      }
      setGuidance('');
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setSending(false);
    }
  };

  return (
    <form
      data-testid="step-steer-composer"
      className="shrink-0 border-t border-doom-border-soft bg-doom-rail px-3 pt-3 pb-2.5"
      onSubmit={(event) => void submit(event)}
    >
      <div className="rounded-lg border border-doom-border bg-doom-deep transition-colors focus-within:border-doom-blue/60">
        <div className="flex min-w-0 items-start gap-2.5 px-3.5 pt-3">
          <span className="mt-[3px] shrink-0 select-none text-base leading-none text-doom-green">&gt;</span>
          <Textarea
            variant="bare"
            data-testid="step-steer-input"
            aria-label="Steering guidance"
            rows={2}
            value={guidance}
            readOnly={sending}
            placeholder="Guide this agent…"
            className="min-w-0 flex-1 text-base leading-relaxed"
            onChange={(event) => setGuidance(event.target.value)}
          />
        </div>
        {error === undefined ? null : (
          <p role="alert" data-testid="step-steer-error" className="px-3.5 pt-2 text-xs text-doom-red">
            {error}
          </p>
        )}
        <div className="flex items-center gap-2 px-3.5 pt-2 pb-2.5">
          <span role="status" data-testid="step-steer-hint" className="min-w-0 truncate text-xs text-doom-faint">
            guidance reaches this step while it is still working
          </span>
          <span className="min-w-0 flex-1" />
          <Button
            data-testid="step-steer-submit"
            type="submit"
            variant="primary"
            size="md"
            className="px-3.5"
            disabled={sending || guidance.trim() === ''}
          >
            {sending ? 'sending…' : 'send'}
          </Button>
        </div>
      </div>
    </form>
  );
}
