import {
  Button,
  Checkbox,
  Dialog,
  DialogBody,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  Input,
  Textarea,
} from '@agimon-ai/doompi-web-components';
import type { SessionFrameSender } from '@agimon-ai/doompi-web-contracts';
import { useState } from 'react';
import { launchProblems, type RunnerLaunchRequest, runnerLaunchLine } from '../lib/launchLine.ts';
import { requestRunnerStart } from '../stores/runnersStore.ts';

const COMMAND_ROWS = 3;
const INTERACTIVE_FIELD_ID = 'runner-launch-interactive-field';

function FieldLabel({ children }: { children: string }) {
  return <span className="text-[9px] font-bold tracking-[0.18em] text-doom-faint">{children}</span>;
}

/**
 * Starts one runner by hand: the command, where it runs, what to call it, and
 * whether it needs a terminal, then the exact `/runners start` line the
 * session will parse.
 *
 * The line is shown rather than hidden. This sends a shell command through the
 * session, and a reader is entitled to see exactly what they are about to run
 * before they run it.
 */
export function LaunchRunnerDialog({
  sessionId,
  sendSessionFrame,
  defaultCwd,
  onClose,
}: {
  sessionId: string;
  sendSessionFrame: SessionFrameSender;
  defaultCwd?: string;
  onClose: () => void;
}) {
  const [command, setCommand] = useState('');
  const [cwd, setCwd] = useState(defaultCwd ?? '');
  const [name, setName] = useState('');
  const [interactive, setInteractive] = useState(false);

  const request: RunnerLaunchRequest = { command, cwd, name, interactive };
  const problems = launchProblems(request);
  const line = runnerLaunchLine(request);

  const launch = (): void => {
    if (problems.length > 0) return;
    requestRunnerStart(sendSessionFrame, sessionId, request);
    onClose();
  };

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <DialogContent width="lg" data-testid="runner-launch-dialog" aria-describedby={undefined}>
        <DialogHeader>
          <DialogTitle data-testid="runner-launch-title">launch a runner</DialogTitle>
        </DialogHeader>
        <DialogBody>
          <div className="flex flex-col gap-1">
            <FieldLabel>COMMAND</FieldLabel>
            <Textarea
              data-testid="runner-launch-command"
              rows={COMMAND_ROWS}
              value={command}
              placeholder="pnpm test"
              onChange={(event) => setCommand(event.target.value)}
              className="text-[11px]"
            />
          </div>

          <div className="flex flex-col gap-2.5 sm:flex-row">
            <div className="flex min-w-0 flex-1 flex-col gap-1">
              <FieldLabel>CWD</FieldLabel>
              <Input
                size="sm"
                data-testid="runner-launch-cwd"
                value={cwd}
                placeholder="the session's own directory"
                onChange={(event) => setCwd(event.target.value)}
                className="text-[10px]"
              />
            </div>
            <div className="flex min-w-0 flex-1 flex-col gap-1">
              <FieldLabel>NAME</FieldLabel>
              <Input
                size="sm"
                data-testid="runner-launch-name"
                value={name}
                placeholder="chosen for you when empty"
                onChange={(event) => setName(event.target.value)}
                className="text-[10px]"
              />
            </div>
          </div>

          {/* Paired by id rather than by nesting: the checkbox renders as a
              button, which a wrapping label does not associate with. */}
          <div className="flex items-center gap-2">
            <Checkbox
              id={INTERACTIVE_FIELD_ID}
              data-testid="runner-launch-interactive"
              checked={interactive}
              onCheckedChange={(checked) => setInteractive(checked === true)}
            />
            <label htmlFor={INTERACTIVE_FIELD_ID} className="text-[10px] text-doom-dim">
              needs a terminal, for a command that prompts (requires rmux or tmux)
            </label>
          </div>

          <div className="flex flex-col gap-1 rounded-md border border-doom-border bg-doom-deep px-3 py-2">
            <FieldLabel>SENT TO THE SESSION</FieldLabel>
            <pre
              data-testid="runner-launch-line"
              className="whitespace-pre-wrap break-words text-[10px] text-doom-green"
            >
              {line}
            </pre>
          </div>

          {problems.length > 0 ? (
            <p data-testid="runner-launch-problem" className="text-[10px] text-doom-red">
              {problems.join(' ')}
            </p>
          ) : null}

          <DialogFooter className="flex-wrap sm:flex-nowrap">
            <span className="w-full text-[9px] text-doom-faint sm:w-auto">
              it appears above once the runtime starts it
            </span>
            <span className="min-w-0 flex-1" />
            <Button variant="outline" size="xs" data-testid="runner-launch-cancel" onClick={onClose}>
              cancel
            </Button>
            <Button
              variant="primary"
              size="xs"
              data-testid="runner-launch-submit"
              disabled={problems.length > 0}
              onClick={launch}
            >
              launch
            </Button>
          </DialogFooter>
        </DialogBody>
      </DialogContent>
    </Dialog>
  );
}
