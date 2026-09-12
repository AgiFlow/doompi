import { Button, Dot, type DotTone } from '@agimon-ai/doompi-web-components';
import type { WebPluginSlotProps } from '@agimon-ai/doompi-web-contracts';
import { LOOP_VIEW_STATUS_KEY, parseLoopStatusView, type LoopStatusState } from '../../types/loopView';

const MANAGE_COMMAND = '/loops';
const DEFAULT_LOOP_COMMAND = '/loop doompi.default';

/** Starts the built-in prompt loop without opening a generic launcher chooser. */
export function DefaultLoopLauncher({
  sessionId,
  sendSessionFrame,
}: Pick<WebPluginSlotProps, 'sessionId' | 'sendSessionFrame'>) {
  return (
    <Button
      variant="subtle"
      size="xs"
      data-testid="activity-loop-default-launch"
      aria-label="launch default loop"
      disabled={sessionId === null}
      onClick={() => {
        if (sessionId === null) return;
        sendSessionFrame(sessionId, { type: 'prompt', message: DEFAULT_LOOP_COMMAND });
      }}
      className="text-2xs font-bold"
    >
      default loop
    </Button>
  );
}

function toneOf(state: LoopStatusState): DotTone {
  if (state === 'running') return 'green';
  if (state === 'stopping') return 'orange';
  return 'yellow';
}

/** Renders active recurring prompts contributed to the Loop activity section. */
export function LoopActivityItems({ statuses }: Pick<WebPluginSlotProps, 'statuses'>) {
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
          </span>
          <span className="truncate pl-3 text-2xs text-doom-faint">{loop.detail}</span>
        </li>
      ))}
    </ul>
  ) : (
    <p className="px-1 text-xs text-doom-faint">loop status unavailable</p>
  );
}

/** Idle-safe Loop activity shell with extension registration and instance slots. */
export function LoopsActivitySection({ sessionId, renderSlot, sendSessionFrame }: WebPluginSlotProps) {
  return (
    <div data-testid="activity-loop-instances" className="flex flex-col gap-2">
      <div className="flex flex-wrap items-center gap-1">
        <DefaultLoopLauncher sessionId={sessionId} sendSessionFrame={sendSessionFrame} />
        {renderSlot('loop.registration')}
      </div>
      {renderSlot('loop.items')}
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
        className="self-end text-2xs font-bold"
      >
        manage
      </Button>
    </div>
  );
}
