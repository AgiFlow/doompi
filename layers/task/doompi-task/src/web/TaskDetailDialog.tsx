import {
  Button,
  Dialog,
  DialogBody,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  Input,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Textarea,
} from '@agimon-ai/doompi-web-components';
import type { SessionFrameSender } from '@agimon-ai/doompi-web-contracts';
import { type ReactNode, useState } from 'react';
import type { WebTask, WebTaskStatus } from '../types/webTasks.ts';
import { requestTaskEdit, requestTaskMessage, taskEditDraft, type TaskEditDraft } from './tasksStore.ts';

/** How the one task dialog is opened: reading it, changing it, or steering its run. */
export type TaskDialogMode = 'view' | 'edit' | 'message';

const STATUS_CHOICES: readonly WebTaskStatus[] = ['pending', 'in_progress', 'completed', 'failed'];
const DESCRIPTION_ROWS = 5;
const MESSAGE_ROWS = 4;

function FieldLabel({ children }: { children: string }) {
  return <span className="text-[9px] font-bold tracking-[0.18em] text-doom-faint">{children}</span>;
}

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex flex-col gap-1.5">
      <FieldLabel>{label}</FieldLabel>
      {children}
    </div>
  );
}

function ReadOnlyValue({ value, testId }: { value: string; testId: string }) {
  return (
    <span data-testid={testId} className="whitespace-pre-wrap break-words text-[11px] leading-relaxed text-doom-dim">
      {value}
    </span>
  );
}

function TaskFacts({ task }: { task: WebTask }) {
  return (
    <div className="flex flex-wrap gap-5">
      <Field label="STATUS">
        <ReadOnlyValue testId="task-detail-status" value={task.status.replace('_', ' ')} />
      </Field>
      {task.activeForm ? (
        <Field label="ACTIVE FORM">
          <ReadOnlyValue testId="task-detail-active-form" value={task.activeForm} />
        </Field>
      ) : null}
      {task.owner ? (
        <Field label="OWNER">
          <ReadOnlyValue testId="task-detail-owner" value={task.owner} />
        </Field>
      ) : null}
      {task.delegation?.agent ? (
        <Field label="DELEGATED TO">
          <ReadOnlyValue
            testId="task-detail-agent"
            value={
              task.delegation.state ? `${task.delegation.agent} · ${task.delegation.state}` : task.delegation.agent
            }
          />
        </Field>
      ) : null}
      {task.blockedBy.length > 0 ? (
        <Field label="BLOCKED BY">
          <ReadOnlyValue testId="task-detail-blocked-by" value={task.blockedBy.map((id) => `#${id}`).join(', ')} />
        </Field>
      ) : null}
      {task.updatedAt ? (
        <Field label="UPDATED">
          <ReadOnlyValue testId="task-detail-updated" value={task.updatedAt} />
        </Field>
      ) : null}
    </div>
  );
}

/**
 * One task, read first and changed second. Every change leaves as a prompt the
 * session can see, so the agent remains the only writer of task state.
 */
export function TaskDetailDialog({
  task,
  sessionId,
  mode: initialMode,
  send,
  onClose,
}: {
  task: WebTask;
  sessionId: string;
  mode: TaskDialogMode;
  send: SessionFrameSender;
  onClose: () => void;
}) {
  const [mode, setMode] = useState<TaskDialogMode>(initialMode);
  const [draft, setDraft] = useState<TaskEditDraft>(() => taskEditDraft(task));
  const [message, setMessage] = useState('');
  const agent = task.delegation?.agent;

  const submitEdit = (): void => {
    if (requestTaskEdit(send, sessionId, task, draft)) onClose();
  };
  const submitMessage = (): void => {
    if (!message.trim() || !agent) return;
    requestTaskMessage(send, sessionId, task.id, agent, message);
    onClose();
  };

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <DialogContent width="lg" data-testid="task-detail-dialog" data-mode={mode} aria-describedby={undefined}>
        <DialogHeader>
          <div className="flex min-w-0 flex-col items-start gap-1 sm:flex-row sm:items-center sm:gap-2.5">
            <span className="text-[9px] text-doom-faint">task #{task.id}</span>
            <DialogTitle data-testid="task-detail-title" className="max-w-full break-words">
              {task.subject}
            </DialogTitle>
          </div>
        </DialogHeader>
        <DialogBody>
          {mode === 'view' ? (
            <>
              <Field label="DESCRIPTION">
                <ReadOnlyValue
                  testId="task-detail-description"
                  value={task.description ?? 'no description on this task'}
                />
              </Field>
              <TaskFacts task={task} />
              <DialogFooter>
                <span className="min-w-0 flex-1" />
                {agent ? (
                  <Button
                    variant="outline"
                    size="xs"
                    data-testid="task-detail-open-message"
                    onClick={() => setMode('message')}
                  >
                    message agent
                  </Button>
                ) : null}
                <Button variant="primary" size="xs" data-testid="task-detail-open-edit" onClick={() => setMode('edit')}>
                  edit
                </Button>
              </DialogFooter>
            </>
          ) : null}

          {mode === 'edit' ? (
            <>
              <Field label="SUBJECT">
                <Input
                  data-testid="task-detail-subject-input"
                  autoFocus
                  value={draft.subject}
                  onChange={(event) => setDraft({ ...draft, subject: event.target.value })}
                />
              </Field>
              <Field label="DESCRIPTION">
                <Textarea
                  data-testid="task-detail-description-input"
                  rows={DESCRIPTION_ROWS}
                  value={draft.description}
                  placeholder="what this task covers"
                  onChange={(event) => setDraft({ ...draft, description: event.target.value })}
                />
              </Field>
              <Field label="STATUS">
                <Select
                  value={draft.status}
                  onValueChange={(value) => setDraft({ ...draft, status: value as WebTaskStatus })}
                >
                  <SelectTrigger
                    data-testid="task-detail-status-input"
                    className="h-7 w-full min-w-0 text-[10px] sm:min-w-[200px]"
                  >
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {STATUS_CHOICES.map((status) => (
                      <SelectItem key={status} value={status}>
                        {status.replace('_', ' ')}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </Field>
              <DialogFooter className="flex-wrap sm:flex-nowrap">
                <span className="w-full text-[9px] text-doom-faint sm:w-auto">
                  saved as one prompt naming only the fields you changed
                </span>
                <span className="min-w-0 flex-1" />
                <Button variant="outline" size="xs" data-testid="task-detail-cancel" onClick={onClose}>
                  cancel
                </Button>
                <Button variant="primary" size="xs" data-testid="task-detail-save" onClick={submitEdit}>
                  save
                </Button>
              </DialogFooter>
            </>
          ) : null}

          {mode === 'message' && agent ? (
            <>
              <Field label={`MESSAGE TO ${agent.toUpperCase()}`}>
                <Textarea
                  data-testid="task-detail-message-input"
                  autoFocus
                  rows={MESSAGE_ROWS}
                  value={message}
                  placeholder="guidance for the run working on this task"
                  onChange={(event) => setMessage(event.target.value)}
                />
              </Field>
              <DialogFooter className="flex-wrap sm:flex-nowrap">
                <span className="w-full text-[9px] text-doom-faint sm:w-auto">
                  steers the run, it does not edit the task
                </span>
                <span className="min-w-0 flex-1" />
                <Button variant="outline" size="xs" data-testid="task-detail-cancel" onClick={onClose}>
                  cancel
                </Button>
                <Button variant="primary" size="xs" data-testid="task-detail-send" onClick={submitMessage}>
                  send
                </Button>
              </DialogFooter>
            </>
          ) : null}
        </DialogBody>
      </DialogContent>
    </Dialog>
  );
}
