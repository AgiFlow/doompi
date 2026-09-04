import {
  Badge,
  Button,
  Dialog,
  DialogBody,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Textarea,
} from '@agimon-ai/doompi-web-components';
import type { SessionFrameSender } from '@agimon-ai/doompi-web-contracts';
import { type KeyboardEvent as ReactKeyboardEvent, useState } from 'react';
import type { SubagentCatalogAgent } from '../types/webSubagents.ts';
import { abbreviateCwd } from './format.ts';
import { launchCommand, type LaunchRequest, modelChoices } from './launchCommand.ts';
import { requestLaunch } from './subagentsStore.ts';

/** The picker's stand-in for "no override"; a Radix item cannot carry an empty value. */
const AGENT_DEFAULT = 'agent-default';
const TASK_ROWS = 4;

function FieldLabel({ children }: { children: string }) {
  return <span className="text-[9px] font-bold tracking-[0.18em] text-doom-faint">{children}</span>;
}

/**
 * Launches one agent from the catalog: the task, whether the child forks
 * this session, a model override, then the exact /run line the session will
 * parse. Enter launches, since the composer sends the same way.
 */
export function LaunchAgentDialog({
  sessionId,
  agent,
  cwd,
  models,
  fork: initialFork,
  initialTask,
  send,
  onClose,
  onLaunched,
}: {
  sessionId: string;
  agent: SubagentCatalogAgent;
  cwd: string;
  models: readonly string[];
  fork: boolean;
  initialTask: string;
  send: SessionFrameSender;
  onClose: () => void;
  onLaunched: () => void;
}) {
  const [task, setTask] = useState(initialTask);
  const [fork, setFork] = useState(initialFork);
  const [model, setModel] = useState(AGENT_DEFAULT);
  const request: LaunchRequest = { agent: agent.name, task, fork, ...(model === AGENT_DEFAULT ? {} : { model }) };
  const command = launchCommand(request);

  const launch = (): void => {
    requestLaunch(send, sessionId, command, agent.name);
    onLaunched();
  };
  const onTaskKeyDown = (event: ReactKeyboardEvent<HTMLTextAreaElement>): void => {
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault();
      launch();
    }
  };

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <DialogContent width="lg" data-testid="launch-dialog" aria-describedby={undefined}>
        <DialogHeader>
          <div className="flex min-w-0 flex-col items-start gap-1 sm:flex-row sm:items-center sm:gap-2.5">
            <span className="text-[9px] text-doom-faint">launch subagent</span>
            <DialogTitle data-testid="launch-agent" className="max-w-full break-words">
              {agent.name}
            </DialogTitle>
            <Badge size="xs" className="max-w-full truncate">
              {agent.packageName ?? agent.source}
            </Badge>
          </div>
        </DialogHeader>
        <DialogBody>
          <p className="text-[11px] leading-relaxed text-doom-dim">{agent.description}</p>
          <div className="flex flex-col gap-1.5">
            <FieldLabel>TASK</FieldLabel>
            <Textarea
              data-testid="launch-task"
              autoFocus
              rows={TASK_ROWS}
              value={task}
              placeholder="what should the agent do? empty runs its own prompt"
              onChange={(event) => setTask(event.target.value)}
              onKeyDown={onTaskKeyDown}
            />
            <span className="text-[9px] text-doom-faint">
              enter launches · shift+enter for a new line · @ for files
            </span>
          </div>
          <div className="flex flex-wrap gap-5">
            <div className="flex flex-col gap-1.5">
              <FieldLabel>CONTEXT</FieldLabel>
              <div className="flex flex-wrap gap-1.5">
                <Button
                  variant={fork ? 'outline' : 'primary'}
                  size="xs"
                  data-testid="launch-fresh"
                  data-active={!fork}
                  onClick={() => setFork(false)}
                >
                  fresh
                </Button>
                <Button
                  variant={fork ? 'primary' : 'outline'}
                  size="xs"
                  data-testid="launch-fork"
                  data-active={fork}
                  onClick={() => setFork(true)}
                >
                  fork this session
                </Button>
              </div>
              <span className="text-[9px] text-doom-faint">fork shares the conversation so far</span>
            </div>
            <div className="flex flex-col gap-1.5">
              <FieldLabel>MODEL</FieldLabel>
              <Select value={model} onValueChange={setModel}>
                <SelectTrigger data-testid="launch-model" className="h-7 w-full min-w-0 text-[10px] sm:min-w-[200px]">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={AGENT_DEFAULT}>agent default{agent.model ? ` · ${agent.model}` : ''}</SelectItem>
                  {modelChoices(agent, models).map((choice) => (
                    <SelectItem key={choice} value={choice}>
                      {choice}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <span className="text-[9px] text-doom-faint">a pick becomes model=… on the command</span>
            </div>
            <div className="flex flex-col gap-1.5">
              <FieldLabel>CWD</FieldLabel>
              <span className="flex h-7 items-center text-[10px] text-doom-dim">{abbreviateCwd(cwd)}</span>
              <span className="text-[9px] text-doom-faint">the session's directory</span>
            </div>
          </div>
          <div className="flex flex-col gap-1 rounded-md border border-doom-border bg-doom-deep px-3 py-2">
            <FieldLabel>SENT TO THE SESSION</FieldLabel>
            <pre data-testid="launch-command" className="whitespace-pre-wrap break-words text-[10px] text-doom-green">
              {command}
            </pre>
          </div>
          <DialogFooter className="flex-wrap sm:flex-nowrap">
            <span className="w-full text-[9px] text-doom-faint sm:w-auto">
              the run opens in its own tab once it starts
            </span>
            <span className="min-w-0 flex-1" />
            <Button variant="outline" size="xs" data-testid="launch-cancel" onClick={onClose}>
              cancel
            </Button>
            <Button variant="primary" size="xs" data-testid="launch-submit" onClick={launch}>
              launch
            </Button>
          </DialogFooter>
        </DialogBody>
      </DialogContent>
    </Dialog>
  );
}
