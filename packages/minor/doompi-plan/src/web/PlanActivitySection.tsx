import { Button } from '@agimon-ai/doompi-web-components';
import type { WebPluginSlotProps } from '@agimon-ai/doompi-web-contracts';
import { parsePlanStatus, PLAN_STATUS_KEY } from '../types/planApi.ts';
import { planTab } from './PlanPanel.tsx';

/**
 * The plan group's body in the activity dock: the plan this session wrote, and
 * the way in.
 *
 * A plan is one document, so the group is one row rather than a list. The row
 * is the whole point of the group: a written plan the reader cannot open is a
 * path in a tool card, which is what this replaces.
 *
 * The session's status line carries the title and the time it was last
 * written, so the row says what the plan is and whether the agent has revised
 * it since the reader last looked, without the dock holding any state.
 */
export function PlanActivitySection({ sessionId, statuses, openTransientTab }: WebPluginSlotProps) {
  const view = parsePlanStatus(statuses[PLAN_STATUS_KEY]);

  if (view === undefined) {
    return (
      <p data-testid="activity-summary-plan" className="px-1 text-[10px] text-doom-faint">
        no plan written yet
      </p>
    );
  }

  return (
    <div data-testid="activity-plan" className="flex flex-col gap-0.5">
      <Button
        variant="ghost"
        size="card"
        data-testid="activity-plan-open"
        title={`open ${view.title}`}
        disabled={sessionId === null}
        onClick={() => {
          if (sessionId === null) return;
          openTransientTab(planTab());
        }}
        className="min-w-0 gap-0.5 rounded-[5px] px-1 py-1 hover:bg-doom-panel"
      >
        <span className="flex w-full min-w-0 items-center gap-1.5">
          <span
            data-testid="activity-plan-title"
            className="min-w-0 flex-1 truncate text-left text-[10px] font-bold text-doom-hi"
          >
            {view.title}
          </span>
          {view.stamp === '' ? null : (
            <span data-testid="activity-plan-stamp" className="shrink-0 text-[9px] tabular-nums text-doom-faint">
              {view.stamp}
            </span>
          )}
        </span>
      </Button>
      <p className="px-1 text-[9px] leading-relaxed text-doom-faint">
        open to read or edit; the agent reads what you save.
      </p>
    </div>
  );
}
