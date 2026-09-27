import type { WebPluginSlotProps } from '@agimon-ai/doompi-core/web';
import { Button, Dot, type DotTone } from '@agimon-ai/doompi-web-components';

import { LOOP_VIEW_STATUS_KEY, parseLoopStatusView, type LoopStatusState } from '../../../../../../types/loopView';

/** The minor mode name the cockpit reports while the agent's loop tools are active. */
const LOOP_MODE = 'loop';

function toneOf(state: LoopStatusState): DotTone {
  if (state === 'running') return 'green';
  if (state === 'stopping') return 'orange';
  return 'yellow';
}

/** Renders active recurring prompts contributed to the Loop activity section. */
export function LoopActivityItems({
  statuses,
  sessionId,
  sendSessionFrame,
}: Pick<WebPluginSlotProps, 'statuses' | 'sessionId' | 'sendSessionFrame'>) {
  const raw = statuses[LOOP_VIEW_STATUS_KEY];
  const loops = parseLoopStatusView(raw);
  const unavailable = raw !== undefined && raw.trim() !== '' && loops === undefined;
  if (!loops && !unavailable) return null;

  return loops ? (
    <ul aria-label="active loops" className="flex flex-col gap-1">
      {loops.map((loop) => (
        <li
          key={loop.instanceId}
          data-testid={`activity-loop-${loop.instanceId}`}
          data-loop-state={loop.state}
          title={`${loop.label}: ${loop.detail}`}
          className="flex min-w-0 flex-col gap-0.5 px-1 py-0.5"
        >
          <span className="flex min-w-0 items-center gap-1.5">
            <Dot tone={toneOf(loop.state)} pulse={loop.state !== 'running'} />
            <span className="min-w-0 flex-1 truncate text-xs font-bold text-doom-hi">{loop.label}</span>
            <span className="shrink-0 text-2xs text-doom-faint">{loop.state}</span>
            <Button
              variant="subtle"
              size="xs"
              aria-label={`stop ${loop.label}`}
              disabled={sessionId === null || loop.state === 'stopping'}
              onClick={() => {
                if (sessionId !== null)
                  sendSessionFrame(sessionId, { type: 'prompt', message: `/loops stop ${loop.instanceId}` });
              }}
            >
              stop
            </Button>
          </span>
          <span className="truncate pl-3 text-2xs text-doom-faint">{loop.detail}</span>
        </li>
      ))}
    </ul>
  ) : (
    <p className="px-1 text-xs text-doom-faint">loop status unavailable</p>
  );
}

/**
 * The Loop activity section. The agent sets loops through its tools while the Loop minor mode is
 * active; this section lists the session's loops whatever the mode, so any of them can be stopped.
 */
export function LoopsActivitySection({ statuses, activeMinorModes, renderSlot }: WebPluginSlotProps) {
  const modeActive = activeMinorModes?.includes(LOOP_MODE) === true;
  const hasLoops = parseLoopStatusView(statuses[LOOP_VIEW_STATUS_KEY]) !== undefined;
  let hint: string | undefined;
  if (!modeActive) hint = 'Activate loop minor mode to set loop or cron job.';
  else if (!hasLoops) hint = 'No loops yet. Ask the agent to set a loop or cron job.';
  return (
    <div data-testid="activity-loop-instances" className="flex flex-col gap-2">
      {renderSlot('loop.registration')}
      {renderSlot('loop.items')}
      {hint === undefined ? null : (
        <p data-testid="activity-loops-hint" className="px-1 text-xs text-doom-faint">
          {hint}
        </p>
      )}
    </div>
  );
}
