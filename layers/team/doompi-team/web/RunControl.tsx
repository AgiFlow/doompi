import { Button, type StatusTone } from '@agimon-ai/doompi-web-components';
import type { SessionFrameSender } from '@agimon-ai/doompi-web-contracts';
import type { MouseEvent as ReactMouseEvent } from 'react';
import type { SubagentRun, SubagentRunState } from '../src/types/webSubagents.ts';
import { formatRunDuration } from './format.ts';
import { dismissRun, isTerminalRun, requestRunStop } from './subagentsStore.ts';

/** One run state, in the host's shared outcome vocabulary. */
export const RUN_BADGE: Readonly<Record<SubagentRunState, { label: string; tone: StatusTone }>> = {
  queued: { label: 'QUEUED', tone: 'neutral' },
  running: { label: 'RUNNING', tone: 'running' },
  done: { label: 'DONE', tone: 'ok' },
  failed: { label: 'FAILED', tone: 'error' },
  stopped: { label: 'STOPPED', tone: 'neutral' },
};

/** How long the run has been going, or took; the clock only matters while it is active. */
export function elapsedRun(run: SubagentRun, now: number): string {
  const end = run.endedAt ?? (run.state === 'running' || run.state === 'queued' ? now : run.lastUpdate);
  return formatRunDuration(Math.max(0, end - run.startedAt));
}

/**
 * The one control a run offers: stop while it is active, clear once it is
 * not. Stop is a request the runtime acknowledges in its own time, so the
 * button reads "stopping" until the run's own status says otherwise.
 */
export function RunControl({
  sessionId,
  run,
  stopping,
  send,
}: {
  sessionId: string;
  run: SubagentRun;
  stopping: boolean;
  send: SessionFrameSender;
}) {
  const act = (event: ReactMouseEvent, action: () => void): void => {
    event.stopPropagation();
    action();
  };
  if (isTerminalRun(run)) {
    return (
      <Button
        variant="outline"
        size="xs"
        data-testid={`run-clear-${run.runId}`}
        title="clear this run from the grid"
        onClick={(event) => act(event, () => dismissRun(sessionId, run.runId))}
      >
        clear
      </Button>
    );
  }
  return (
    <Button
      variant={stopping ? 'outline' : 'danger-outline'}
      size="xs"
      data-testid={`run-stop-${run.runId}`}
      data-stopping={stopping}
      disabled={stopping}
      title={stopping ? 'stop requested; the run reports its own final state' : 'ask the runtime to stop this run'}
      onClick={(event) => act(event, () => requestRunStop(send, sessionId, run.runId))}
    >
      {stopping ? 'stopping…' : 'stop'}
    </Button>
  );
}
