import { Button, Dot, type DotTone } from '@agimon-ai/doompi-web-components';
import type { WebPluginSlotProps } from '@agimon-ai/doompi-web-contracts';
import { LOOP_VIEW_STATUS_KEY, parseLoopStatusView, type LoopStatusState } from '../src/types/loopView.ts';

const MANAGE_COMMAND = '/loops';

function toneOf(state: LoopStatusState): DotTone {
  if (state === 'running') return 'green';
  if (state === 'stopping') return 'orange';
  return 'yellow';
}

/** Active recurring prompts owned by the focused session, plus the existing management flow. */
export function LoopsActivitySection({ sessionId, statuses, sendSessionFrame }: WebPluginSlotProps) {
  const raw = statuses[LOOP_VIEW_STATUS_KEY];
  const loops = parseLoopStatusView(raw);
  const unavailable = raw !== undefined && raw.trim() !== '' && loops === undefined;
  if (!loops && !unavailable) return null;

  return (
    <div data-testid="activity-loop-instances" className="flex flex-col gap-2">
      {loops ? (
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
                <span className="min-w-0 flex-1 truncate text-[10px] font-bold text-doom-hi">{loop.label}</span>
                <span className="shrink-0 text-[9px] text-doom-faint">{loop.state}</span>
              </span>
              <span className="truncate pl-3 text-[9px] text-doom-faint">{loop.detail}</span>
            </li>
          ))}
        </ul>
      ) : (
        <p className="px-1 text-[10px] text-doom-faint">loop status unavailable</p>
      )}
      <Button
        variant="subtle"
        size="xs"
        data-testid="activity-loops-manage"
        aria-label="manage loops"
        disabled={sessionId === null}
        onClick={() => {
          if (sessionId === null) return;
          sendSessionFrame(sessionId, { type: 'prompt', message: MANAGE_COMMAND });
        }}
        className="self-end text-[8px] font-bold"
      >
        manage
      </Button>
    </div>
  );
}
