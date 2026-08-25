import { Button, Dot, type DotTone } from '@agimon-ai/doompi-web-components';
import type { WebPluginSlotProps } from '@agimon-ai/doompi-web-contracts';
import { useStore } from '@tanstack/react-store';
import { useEffect, useState } from 'react';
import { type WorkflowActivityTone, workflowActivityRows } from './workflowActivity.ts';
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

/**
 * The workflows group's body in the activity dock: the session's runs, each
 * a row that opens the workflows tab on that run. This replaces the widget
 * signal the runtime publishes, which only says the mode is installed.
 */
export function WorkflowsActivitySection({ sessionId, openTab }: WebPluginSlotProps) {
  const runs = useStore(workflows.store, (state) => workflows.select(state, sessionId).runs);
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), TICK_MS);
    return () => clearInterval(timer);
  }, []);

  const rows = workflowActivityRows(runs, now);
  if (rows.length === 0) {
    return (
      <p data-testid="activity-summary-workflows" className="px-1 text-[10px] text-doom-faint">
        idle
      </p>
    );
  }

  return (
    <div data-testid="activity-workflow-runs" className="flex flex-col gap-0.5">
      {rows.map((row) => (
        <Button
          key={row.identity}
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
      ))}
    </div>
  );
}
