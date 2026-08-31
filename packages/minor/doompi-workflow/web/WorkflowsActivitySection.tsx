import { Button, ChevronDownIcon, ChevronRightIcon, Dot, type DotTone } from '@agimon-ai/doompi-web-components';
import type { WebPluginSlotProps } from '@agimon-ai/doompi-web-contracts';
import { useStore } from '@tanstack/react-store';
import { useEffect, useState } from 'react';
import {
  type WorkflowActivityGroupName,
  type WorkflowActivityRow,
  type WorkflowActivityTone,
  workflowActivityGroups,
  workflowActivityRows,
} from './workflowActivity.ts';
import { openCatalog } from './catalogStore.ts';
import { focusRun, workflows } from './workflowsStore.ts';

const TICK_MS = 10_000;
const WORKFLOWS_TAB = 'workflows';

const TONE_DOT: Readonly<Record<WorkflowActivityTone, DotTone>> = {
  running: 'yellow',
  paused: 'yellow',
  failed: 'red',
  done: 'green',
  skipped: 'muted',
};

const TONE_DETAIL: Readonly<Record<WorkflowActivityTone, string>> = {
  running: 'text-doom-faint',
  paused: 'text-doom-yellow',
  failed: 'text-doom-red',
  done: 'text-doom-faint',
  skipped: 'text-doom-faint',
};

const GROUP_LABEL: Readonly<Record<WorkflowActivityGroupName, string>> = {
  running: 'text-doom-yellow',
  failed: 'text-doom-red',
  successful: 'text-doom-green',
};

/**
 * The workflows group's body in the activity dock: every run this session
 * started, split into running, failed and successful.
 *
 * A session keeps its whole history, so the groups fold: failures open because
 * they are the only ones that need an answer, and the rest stay out of the way
 * until somebody asks. Idle offers the catalog instead of saying nothing.
 */
export function WorkflowsActivitySection({ sessionId, openTab }: WebPluginSlotProps) {
  const runs = useStore(workflows.store, (state) => workflows.select(state, sessionId).runs);
  const [now, setNow] = useState(() => Date.now());
  const [folded, setFolded] = useState<Partial<Record<WorkflowActivityGroupName, boolean>>>({});

  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), TICK_MS);
    return () => clearInterval(timer);
  }, []);

  const groups = workflowActivityGroups(workflowActivityRows(runs, now));
  if (groups.length === 0) {
    return (
      <div className="flex items-center gap-2 px-1">
        <p data-testid="activity-summary-workflows" className="text-[10px] text-doom-faint">
          idle
        </p>
        <Button
          variant="link"
          size="xs"
          data-testid="activity-workflow-launch"
          className="px-0"
          onClick={() => {
            if (sessionId === null) return;
            openCatalog(sessionId);
            openTab(WORKFLOWS_TAB);
          }}
        >
          launch a workflow
        </Button>
      </div>
    );
  }

  const RunRow = ({ row }: { row: WorkflowActivityRow }) => (
    <Button
      variant="ghost"
      size="card"
      data-testid={`activity-workflow-${row.runKey}`}
      data-run-tone={row.tone}
      title="open this run in the workflows tab"
      onClick={() => {
        if (sessionId === null) return;
        focusRun(sessionId, row.identity);
        openTab(WORKFLOWS_TAB);
      }}
      className="min-w-0 gap-0.5 rounded-[5px] px-1 py-1 hover:bg-doom-panel"
    >
      <span className="flex min-w-0 items-center gap-1.5">
        <Dot tone={TONE_DOT[row.tone]} pulse={row.tone === 'running'} />
        <span
          className={`min-w-0 flex-1 truncate text-[10px] font-bold ${
            row.tone === 'running' || row.tone === 'paused' ? 'text-doom-hi' : 'text-doom-dim'
          }`}
        >
          {row.name}
        </span>
        <span className="shrink-0 text-[9px] text-doom-faint">{row.elapsed}</span>
      </span>
      <span className={`truncate pl-3 text-[9px] ${TONE_DETAIL[row.tone]}`}>{row.detail}</span>
    </Button>
  );

  return (
    <div data-testid="activity-workflow-runs" className="flex flex-col gap-0.5">
      {groups.map((group) => {
        const open = folded[group.name] ?? group.openByDefault;
        return (
          <div key={group.name} className="flex flex-col gap-0.5">
            <Button
              variant="ghost"
              size="xs"
              data-testid={`activity-workflow-group-${group.name}`}
              data-open={open}
              aria-expanded={open}
              onClick={() => setFolded((current) => ({ ...current, [group.name]: !open }))}
              className="justify-start gap-1.5 rounded-[5px] px-1 py-0.5 hover:bg-doom-panel"
            >
              {open ? (
                <ChevronDownIcon className="h-2.5 w-2.5 text-doom-faint" />
              ) : (
                <ChevronRightIcon className="h-2.5 w-2.5 text-doom-faint" />
              )}
              <span className={`text-[10px] font-bold ${GROUP_LABEL[group.name]}`}>{group.name}</span>
              <span className="text-[9px] text-doom-faint">{group.rows.length}</span>
            </Button>
            {open ? (
              <div className="flex flex-col gap-0.5 pl-2">
                {group.rows.map((row) => (
                  <RunRow key={row.identity} row={row} />
                ))}
              </div>
            ) : (
              <span className="truncate pl-5 text-[9px] text-doom-faint">
                {group.rows
                  .slice(0, 2)
                  .map((row) => row.name)
                  .join(', ')}
                {group.rows.length > 2 ? `, and ${group.rows.length - 2} more` : ''}
              </span>
            )}
          </div>
        );
      })}
    </div>
  );
}
