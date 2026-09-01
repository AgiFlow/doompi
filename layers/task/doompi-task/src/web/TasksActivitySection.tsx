import {
  Button,
  ChevronDownIcon,
  ChevronRightIcon,
  Dot,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
  EditIcon,
  KebabIcon,
  MessageIcon,
  TrashIcon,
  type DotTone,
} from '@agimon-ai/doompi-web-components';
import type { WebPluginSlotProps } from '@agimon-ai/doompi-web-contracts';
import { useStore } from '@tanstack/react-store';
import { useState } from 'react';
import type { WebTask } from '../types/webTasks.ts';
import { TaskDetailDialog, type TaskDialogMode } from './TaskDetailDialog.tsx';
import { requestTaskRemoval, tasks } from './tasksStore.ts';

const STATUS_TONE: Readonly<Record<WebTask['status'], DotTone>> = {
  pending: 'muted',
  in_progress: 'yellow',
  completed: 'green',
  failed: 'red',
  deleted: 'muted',
};

interface DialogState {
  taskId: number;
  mode: TaskDialogMode;
}

function TaskRow({
  task,
  sessionId,
  sendSessionFrame,
  openDialog,
}: {
  task: WebTask;
  sessionId: string;
  sendSessionFrame: WebPluginSlotProps['sendSessionFrame'];
  openDialog: (mode: TaskDialogMode) => void;
}) {
  const detail = task.status === 'in_progress' ? task.activeForm : task.description;
  const agent = task.delegation?.agent;
  return (
    <div
      data-testid={`activity-task-${task.id}`}
      data-task-status={task.status}
      className="flex flex-col gap-1 rounded-[5px] px-1 py-1"
    >
      <div className="grid min-w-0 grid-cols-[auto_minmax(0,1fr)_auto_auto] items-center gap-x-1.5">
        <Dot tone={STATUS_TONE[task.status]} pulse={task.status === 'in_progress'} />
        <button
          type="button"
          data-testid={`activity-task-title-${task.id}`}
          title={task.subject}
          onClick={() => openDialog('view')}
          className={`min-w-0 truncate text-left text-[10px] font-bold hover:underline ${task.status === 'failed' ? 'text-doom-red' : task.status === 'completed' ? 'text-doom-dim' : 'text-doom-hi'}`}
        >
          <span className="text-doom-faint">#{task.id}</span> {task.subject}
        </button>
        <span className="shrink-0 text-[8px] text-doom-faint">{task.status.replace('_', ' ')}</span>
        {task.status !== 'completed' && task.status !== 'deleted' ? (
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button
                variant="ghost"
                size="icon"
                data-testid={`activity-task-menu-${task.id}`}
                aria-label={`task #${task.id} actions`}
                title={`task #${task.id} actions`}
                className="self-center shrink-0 text-doom-faint hover:bg-doom-deep hover:text-doom-hi data-[state=open]:bg-doom-deep data-[state=open]:text-doom-hi"
              >
                <KebabIcon className="h-3 w-3" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent data-testid={`activity-task-menu-list-${task.id}`}>
              <DropdownMenuItem data-testid={`activity-task-edit-${task.id}`} onSelect={() => openDialog('edit')}>
                <EditIcon className="h-3 w-3" />
                Edit
              </DropdownMenuItem>
              {agent ? (
                <DropdownMenuItem
                  data-testid={`activity-task-message-${task.id}`}
                  onSelect={() => openDialog('message')}
                >
                  <MessageIcon className="h-3 w-3" />
                  Message agent
                </DropdownMenuItem>
              ) : null}
              <DropdownMenuItem
                variant="destructive"
                data-testid={`activity-task-remove-${task.id}`}
                onSelect={() => requestTaskRemoval(sendSessionFrame, sessionId, task.id)}
              >
                <TrashIcon className="h-3 w-3" />
                Remove
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        ) : null}
      </div>
      {detail || agent || task.blockedBy.length > 0 ? (
        <span className="truncate pl-3 text-[9px] text-doom-faint">
          {agent ? `[${agent}] ` : ''}
          {detail ?? ''}
          {task.blockedBy.length > 0 ? ` · blocked by ${task.blockedBy.map((id) => `#${id}`).join(', ')}` : ''}
        </span>
      ) : null}
    </div>
  );
}

/** Session task graph in the activity dock. Empty graphs have no cockpit presence. */
export function TasksActivitySection({ sessionId, sendSessionFrame }: WebPluginSlotProps) {
  const sessionTasks = useStore(tasks.store, (state) => tasks.select(state, sessionId).tasks);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [dialog, setDialog] = useState<DialogState>();
  if (sessionId === null || sessionTasks.length === 0) return null;

  const active = sessionTasks.filter((task) => task.status === 'pending' || task.status === 'in_progress');
  const history = sessionTasks.filter((task) => task.status === 'completed' || task.status === 'failed');
  const dialogTask = dialog ? sessionTasks.find((task) => task.id === dialog.taskId) : undefined;
  return (
    <section data-testid="activity-tasks" className="flex flex-col gap-2 border-b border-doom-border-soft px-3 py-3">
      <div className="flex items-center gap-2 px-1">
        <span
          aria-hidden
          className={
            active.length > 0
              ? 'animate-pulse text-[11px] font-bold text-doom-yellow'
              : 'text-[11px] font-bold text-doom-faint'
          }
        >
          #
        </span>
        <span className="flex-1 text-[11px] font-bold text-doom-text">tasks</span>
        <span className="text-[9px] text-doom-faint">{active.length} active</span>
      </div>
      {active.length > 0 ? (
        <div className="flex flex-col gap-0.5">
          {active.map((task) => (
            <TaskRow
              key={task.id}
              task={task}
              sessionId={sessionId}
              sendSessionFrame={sendSessionFrame}
              openDialog={(mode) => setDialog({ taskId: task.id, mode })}
            />
          ))}
        </div>
      ) : null}
      {history.length > 0 ? (
        <div className="flex flex-col gap-0.5">
          <Button
            variant="ghost"
            size="xs"
            aria-expanded={historyOpen}
            onClick={() => setHistoryOpen((open) => !open)}
            className="justify-start gap-1.5 rounded-[5px] px-1 py-0.5 hover:bg-doom-panel"
          >
            {historyOpen ? (
              <ChevronDownIcon className="h-2.5 w-2.5 text-doom-faint" />
            ) : (
              <ChevronRightIcon className="h-2.5 w-2.5 text-doom-faint" />
            )}
            <span className="text-[10px] font-bold text-doom-dim">session</span>
            <span className="text-[9px] text-doom-faint">{history.length}</span>
          </Button>
          {historyOpen ? (
            <div className="flex flex-col gap-0.5 pl-2">
              {history.map((task) => (
                <TaskRow
                  key={task.id}
                  task={task}
                  sessionId={sessionId}
                  sendSessionFrame={sendSessionFrame}
                  openDialog={(mode) => setDialog({ taskId: task.id, mode })}
                />
              ))}
            </div>
          ) : null}
        </div>
      ) : null}
      {dialog && dialogTask ? (
        <TaskDetailDialog
          key={`${dialogTask.id}-${dialog.mode}`}
          task={dialogTask}
          sessionId={sessionId}
          mode={dialog.mode}
          send={sendSessionFrame}
          onClose={() => setDialog(undefined)}
        />
      ) : null}
    </section>
  );
}
