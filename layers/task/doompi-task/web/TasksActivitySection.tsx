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
  Textarea,
  TrashIcon,
  type DotTone,
} from '@agimon-ai/doompi-web-components';
import type { WebPluginSlotProps } from '@agimon-ai/doompi-web-contracts';
import { useStore } from '@tanstack/react-store';
import { useRef, useState } from 'react';
import type { WebTask } from '../src/types/webTasks.ts';
import { requestTaskInstruction, requestTaskRemoval, tasks, type TaskInstructionKind } from './tasksStore.ts';

const STATUS_TONE: Readonly<Record<WebTask['status'], DotTone>> = {
  pending: 'muted',
  in_progress: 'yellow',
  completed: 'green',
  failed: 'red',
  deleted: 'muted',
};

interface EditorState {
  taskId: number;
  kind: TaskInstructionKind;
  value: string;
}

function TaskRow({
  task,
  sessionId,
  sendSessionFrame,
  editor,
  setEditor,
}: {
  task: WebTask;
  sessionId: string;
  sendSessionFrame: WebPluginSlotProps['sendSessionFrame'];
  editor: EditorState | undefined;
  setEditor: (editor: EditorState | undefined) => void;
}) {
  const editing = editor?.taskId === task.id;
  const editorRequested = useRef(false);
  const editorInput = useRef<HTMLTextAreaElement>(null);
  const detail = task.status === 'in_progress' ? task.activeForm : task.description;
  return (
    <div
      data-testid={`activity-task-${task.id}`}
      data-task-status={task.status}
      className="flex flex-col gap-1 rounded-[5px] px-1 py-1"
    >
      <div className="grid min-w-0 grid-cols-[auto_minmax(0,1fr)_auto_auto] items-center gap-x-1.5">
        <Dot tone={STATUS_TONE[task.status]} pulse={task.status === 'in_progress'} />
        <span
          data-testid={`activity-task-title-${task.id}`}
          className={`min-w-0 truncate text-[10px] font-bold ${task.status === 'failed' ? 'text-doom-red' : task.status === 'completed' ? 'text-doom-dim' : 'text-doom-hi'}`}
        >
          <span className="text-doom-faint">#{task.id}</span> {task.subject}
        </span>
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
            <DropdownMenuContent
              data-testid={`activity-task-menu-list-${task.id}`}
              onCloseAutoFocus={(event) => {
                if (!editorRequested.current) return;
                editorRequested.current = false;
                event.preventDefault();
                editorInput.current?.focus();
              }}
            >
              <DropdownMenuItem
                data-testid={`activity-task-edit-${task.id}`}
                onSelect={() => {
                  editorRequested.current = true;
                  setEditor({ taskId: task.id, kind: 'edit', value: '' });
                }}
              >
                <EditIcon className="h-3 w-3" />
                Edit
              </DropdownMenuItem>
              <DropdownMenuItem
                data-testid={`activity-task-note-${task.id}`}
                onSelect={() => {
                  editorRequested.current = true;
                  setEditor({ taskId: task.id, kind: 'note', value: '' });
                }}
              >
                <MessageIcon className="h-3 w-3" />
                Note
              </DropdownMenuItem>
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
      {detail || task.delegation?.agent || task.blockedBy.length > 0 ? (
        <span className="truncate pl-3 text-[9px] text-doom-faint">
          {task.delegation?.agent ? `[${task.delegation.agent}] ` : ''}
          {detail ?? ''}
          {task.blockedBy.length > 0 ? ` · blocked by ${task.blockedBy.map((id) => `#${id}`).join(', ')}` : ''}
        </span>
      ) : null}
      {editing ? (
        <form
          className="flex flex-col gap-1 pl-3"
          onSubmit={(event) => {
            event.preventDefault();
            if (!editor.value.trim()) return;
            requestTaskInstruction(sendSessionFrame, sessionId, task.id, editor.kind, editor.value);
            setEditor(undefined);
          }}
        >
          <Textarea
            ref={editorInput}
            autoFocus
            rows={2}
            size="sm"
            value={editor.value}
            placeholder={editor.kind === 'note' ? 'note for the agent' : 'what should change'}
            onChange={(event) => setEditor({ ...editor, value: event.target.value })}
            className="text-[9px]"
          />
          <div className="flex gap-2">
            <Button type="submit" variant="link" size="xs" className="h-auto px-0 text-[8px]">
              send
            </Button>
            <Button
              type="button"
              variant="link"
              size="xs"
              className="h-auto px-0 text-[8px] text-doom-faint"
              onClick={() => setEditor(undefined)}
            >
              cancel
            </Button>
          </div>
        </form>
      ) : null}
    </div>
  );
}

/** Session task graph in the activity dock. Empty graphs have no cockpit presence. */
export function TasksActivitySection({ sessionId, sendSessionFrame }: WebPluginSlotProps) {
  const sessionTasks = useStore(tasks.store, (state) => tasks.select(state, sessionId).tasks);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [editor, setEditor] = useState<EditorState>();
  if (sessionId === null || sessionTasks.length === 0) return null;

  const active = sessionTasks.filter((task) => task.status === 'pending' || task.status === 'in_progress');
  const history = sessionTasks.filter((task) => task.status === 'completed' || task.status === 'failed');
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
              editor={editor}
              setEditor={setEditor}
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
                  editor={editor}
                  setEditor={setEditor}
                />
              ))}
            </div>
          ) : null}
        </div>
      ) : null}
    </section>
  );
}
