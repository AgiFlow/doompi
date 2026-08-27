import {
  Button,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
  KebabIcon,
} from '@agimon-ai/doompi-web-components';
import type { WebPluginSlotProps } from '@agimon-ai/doompi-web-contracts';
import { useState } from 'react';
import { GOAL_VIEW_STATUS_KEY, parseGoalStatusView } from '../src/types/goalView.ts';
import { EditGoalDialog } from './EditGoalDialog.tsx';
import { budgetHintOf, CLEAR_GOAL_COMMAND } from './goalCommands.ts';
import { RemoveGoalDialog } from './RemoveGoalDialog.tsx';

/**
 * The goal group's body in the activity dock: the objective this session is
 * working to, and the two things a reader can do about it.
 *
 * A session holds one goal, so the group is one row rather than a list. The row
 * exists because a goal only the terminal can see is a goal the cockpit's
 * reader has to take on trust: it shapes every turn, it outlives the mode that
 * set it, and until now it left no trace in the browser.
 *
 * Edit and remove sit behind a kebab for the same reason the session rail's do.
 * They are deliberate acts on work the agent is part-way through, and a button
 * sitting under the pointer beside a row that updates on its own is one
 * misclick away from ending a turn.
 */

/** What the row is doing: showing itself, its menu, an edit, or asking before a clear. */
type RowMode = 'view' | 'menu' | 'edit' | 'confirm';

export function GoalActivitySection({ sessionId, statuses, sendSessionFrame }: WebPluginSlotProps) {
  const [mode, setMode] = useState<RowMode>('view');
  const view = parseGoalStatusView(statuses[GOAL_VIEW_STATUS_KEY]);

  if (view === undefined) {
    return (
      <p data-testid="activity-summary-goal" className="px-1 text-[10px] text-doom-faint">
        no goal set yet
      </p>
    );
  }

  const send = (command: string): void => {
    if (sessionId === null) return;
    sendSessionFrame(sessionId, { type: 'prompt', message: command });
  };

  return (
    // Not `activity-goal`: the dock already puts that on the group frame this
    // renders inside, and two of them make every locator ambiguous.
    <div data-testid="activity-goal-row" className="flex flex-col gap-0.5">
      <div className="flex min-w-0 items-start gap-1.5 px-1">
        <span className="flex min-w-0 flex-1 flex-col gap-0.5">
          <span data-testid="activity-goal-objective" className="text-[10px] font-bold text-doom-hi">
            {view.objective}
          </span>
          <span data-testid="activity-goal-state" className="text-[9px] tabular-nums text-doom-faint">
            {view.state}
          </span>
        </span>
        <DropdownMenu
          open={mode === 'menu'}
          onOpenChange={(next) => setMode((current) => (next ? 'menu' : current === 'menu' ? 'view' : current))}
        >
          <DropdownMenuTrigger asChild>
            <Button
              variant="ghost"
              size="icon"
              data-testid="activity-goal-menu"
              title="goal actions"
              disabled={sessionId === null}
              className="shrink-0 text-doom-faint hover:bg-doom-deep hover:text-doom-hi data-[state=open]:bg-doom-deep data-[state=open]:text-doom-hi"
            >
              <KebabIcon className="h-3 w-3" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent data-testid="activity-goal-menu-list">
            <DropdownMenuItem data-testid="activity-goal-edit" onSelect={() => setMode('edit')}>
              edit
            </DropdownMenuItem>
            <DropdownMenuItem
              variant="destructive"
              data-testid="activity-goal-remove"
              onSelect={() => setMode('confirm')}
            >
              remove
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>

      {/* Mounted only while open, so the form opens on the objective the session
          is reporting now rather than the one it reported when the dock did. */}
      {mode === 'edit' ? (
        <EditGoalDialog
          open
          objective={view.objective}
          budgetHint={budgetHintOf(view.state)}
          onSubmit={(command) => {
            send(command);
            setMode('view');
          }}
          onCancel={() => setMode('view')}
        />
      ) : null}
      <RemoveGoalDialog
        objective={view.objective}
        open={mode === 'confirm'}
        onConfirm={() => {
          send(CLEAR_GOAL_COMMAND);
          setMode('view');
        }}
        onCancel={() => setMode('view')}
      />
    </div>
  );
}
