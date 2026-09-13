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
import { type KeyboardEvent as ReactKeyboardEvent, useState } from 'react';

import type { SubagentCatalogAgent } from '../../types/webSubagents';
import { launchAgent } from '../api/catalog';
import { abbreviateCwd } from '../lib/format';
import { type LaunchRequest, modelChoices } from '../lib/launchCommand';
import { clearPendingLaunch, requestLaunch } from '../stores/subagentsStore';

/** The picker's stand-in for "no override"; a Radix item cannot carry an empty value. */
const AGENT_DEFAULT = 'agent-default';
const TASK_ROWS = 4;

function FieldLabel({ children }: { children: string }) {
  return <span className="text-2xs font-bold tracking-widest text-doom-faint">{children}</span>;
}

/**
 * Launches one agent from the catalog: the task, whether the child forks
 * this session, and a model override. The session server starts the child.
 */
export function LaunchAgentDialog({
  sessionId,
  agent,
  cwd,
  models,
  fork: initialFork,
  initialTask,
  onClose,
  onLaunched,
}: {
  sessionId: string;
  agent: SubagentCatalogAgent;
  cwd: string;
  models: readonly string[];
  fork: boolean;
  initialTask: string;
  onClose: () => void;
  onLaunched: () => void;
}) {
  const [task, setTask] = useState(initialTask);
  const [fork, setFork] = useState(initialFork);
  const [model, setModel] = useState(AGENT_DEFAULT);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>();
  const request: LaunchRequest = { agent: agent.name, task, fork, ...(model === AGENT_DEFAULT ? {} : { model }) };

  const launch = async (): Promise<void> => {
    if (busy) return;
    setBusy(true);
    setError(undefined);
    requestLaunch(sessionId, agent.name);
    try {
      await launchAgent(sessionId, request);
      onLaunched();
    } catch (cause) {
      clearPendingLaunch(sessionId);
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  };
  const onTaskKeyDown = (event: ReactKeyboardEvent<HTMLTextAreaElement>): void => {
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault();
      void launch();
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
            <span className="text-2xs text-doom-faint">launch subagent</span>
            <DialogTitle data-testid="launch-agent" className="max-w-full break-words">
              {agent.name}
            </DialogTitle>
            <Badge size="xs" className="max-w-full truncate">
              {agent.packageName ?? agent.source}
            </Badge>
          </div>
        </DialogHeader>
        <DialogBody>
          <p className="text-sm leading-relaxed text-doom-dim">{agent.description}</p>
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
            <span className="text-2xs text-doom-faint">enter launches · shift+enter for a new line · @ for files</span>
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
              <span className="text-2xs text-doom-faint">fork shares the conversation so far</span>
            </div>
            <div className="flex flex-col gap-1.5">
              <FieldLabel>MODEL</FieldLabel>
              <Select value={model} onValueChange={setModel}>
                <SelectTrigger data-testid="launch-model" className="h-7 w-full min-w-0 text-xs sm:min-w-[200px]">
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
              <span className="text-2xs text-doom-faint">leave unset to use the agent's default</span>
            </div>
            <div className="flex flex-col gap-1.5">
              <FieldLabel>CWD</FieldLabel>
              <span className="flex h-7 items-center text-xs text-doom-dim">{abbreviateCwd(cwd)}</span>
              <span className="text-2xs text-doom-faint">the session's directory</span>
            </div>
          </div>
          {error ? (
            <p role="alert" className="text-xs text-doom-red">
              {error}
            </p>
          ) : null}
          <DialogFooter className="flex-wrap sm:flex-nowrap">
            <span className="w-full text-2xs text-doom-faint sm:w-auto">
              the run opens in its own tab once it starts
            </span>
            <span className="min-w-0 flex-1" />
            <Button variant="outline" size="xs" data-testid="launch-cancel" onClick={onClose}>
              cancel
            </Button>
            <Button
              variant="primary"
              size="xs"
              data-testid="launch-submit"
              disabled={busy}
              onClick={() => void launch()}
            >
              {busy ? 'launching…' : 'launch'}
            </Button>
          </DialogFooter>
        </DialogBody>
      </DialogContent>
    </Dialog>
  );
}
