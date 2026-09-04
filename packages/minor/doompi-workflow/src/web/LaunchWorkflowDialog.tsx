import {
  Badge,
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
import { type KeyboardEvent as ReactKeyboardEvent, useState } from 'react';
import type { WorkflowCatalogEntryView, WorkflowCatalogInputView } from '../types/webWorkflows.ts';
import {
  initialInputs,
  initialRunner,
  launchProblems,
  workflowLaunchLine,
  type WorkflowLaunchRequest,
} from './launchLine.ts';
import { requestLaunch } from './workflowsStore.ts';

const PROMPT_ROWS = 3;
const BOOLEAN_TYPE = 'boolean';
const BOOLEAN_VALUES = ['true', 'false'] as const;

function FieldLabel({ children }: { children: string }) {
  return <span className="text-[9px] font-bold tracking-[0.18em] text-doom-faint">{children}</span>;
}

/** One `workflow_dispatch` input: a picker when the workflow constrains it, a field otherwise. */
function InputField({
  input,
  value,
  onChange,
}: {
  input: WorkflowCatalogInputView;
  value: string;
  onChange: (next: string) => void;
}) {
  const options = input.options ?? (input.type === BOOLEAN_TYPE ? [...BOOLEAN_VALUES] : undefined);
  const hint = [
    input.required === true ? 'required' : undefined,
    input.default === undefined ? undefined : `default: ${input.default}`,
    input.description,
  ]
    .filter((part): part is string => part !== undefined && part !== '')
    .join(' · ');
  return (
    <div
      className="flex flex-col gap-1.5 sm:flex-row sm:items-center sm:gap-2.5"
      data-testid={`launch-input-${input.name}`}
    >
      <span className="min-w-0 truncate text-[10px] font-bold text-doom-text sm:w-28 sm:shrink-0">
        {input.name}
        {input.required === true ? <span className="text-doom-yellow"> *</span> : null}
      </span>
      {options === undefined ? (
        <Input
          className="min-w-0 flex-1"
          value={value}
          placeholder={input.default ?? ''}
          onChange={(event) => onChange(event.target.value)}
        />
      ) : (
        <Select value={value === '' ? undefined : value} onValueChange={onChange}>
          <SelectTrigger className="h-7 w-full min-w-0 text-[10px] sm:min-w-[160px]">
            <SelectValue placeholder="choose…" />
          </SelectTrigger>
          <SelectContent>
            {options.map((option) => (
              <SelectItem key={option} value={option}>
                {option}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      )}
      <span className="min-w-0 truncate text-[9px] text-doom-faint sm:w-40 sm:shrink-0">{hint}</span>
    </div>
  );
}

/**
 * Launches one workflow from the catalog: the prompt, every input the file
 * declares, the runner when it declares a runner map, then the exact line the
 * session will parse. Enter launches, since the composer sends the same way.
 */
export function LaunchWorkflowDialog({
  sessionId,
  workflow,
  cwd,
  initialPrompt,
  send,
  onClose,
  onLaunched,
}: {
  sessionId: string;
  workflow: WorkflowCatalogEntryView;
  cwd: string;
  initialPrompt: string;
  send: SessionFrameSender;
  onClose: () => void;
  onLaunched: () => void;
}) {
  const [prompt, setPrompt] = useState(initialPrompt);
  const [inputs, setInputs] = useState<Record<string, string>>(() => initialInputs(workflow));
  const [runner, setRunner] = useState<string | undefined>(() => initialRunner(workflow));
  const request: WorkflowLaunchRequest = {
    workflow: workflow.name === '' ? workflow.relativePath : workflow.name,
    ...(runner === undefined ? {} : { runner }),
    inputs,
    ...(prompt.trim() === '' ? {} : { prompt: prompt.trim() }),
  };
  const problems = launchProblems(workflow, request);
  const line = workflowLaunchLine(request);

  const launch = (): void => {
    if (problems.length > 0) return;
    requestLaunch(send, sessionId, line, workflow.path);
    onLaunched();
  };
  const onPromptKeyDown = (event: ReactKeyboardEvent<HTMLTextAreaElement>): void => {
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
      <DialogContent width="lg" data-testid="launch-workflow-dialog" aria-describedby={undefined}>
        <DialogHeader>
          <div className="flex min-w-0 flex-col items-start gap-1 sm:flex-row sm:items-center sm:gap-2.5">
            <span className="text-[9px] text-doom-faint">launch workflow</span>
            <DialogTitle data-testid="launch-workflow-name" className="max-w-full break-words">
              {workflow.name}
            </DialogTitle>
            <Badge size="xs" className="max-w-full truncate">
              {workflow.relativePath}
            </Badge>
          </div>
        </DialogHeader>
        <DialogBody>
          <p className="text-[11px] leading-relaxed text-doom-dim">
            {workflow.description || 'This workflow declares no description.'}
          </p>
          <div className="flex flex-col gap-1.5">
            <FieldLabel>PROMPT</FieldLabel>
            <Textarea
              data-testid="launch-prompt"
              autoFocus
              rows={PROMPT_ROWS}
              value={prompt}
              placeholder="what should this run do? it becomes WORKFLOW_CONTEXT for every job"
              onChange={(event) => setPrompt(event.target.value)}
              onKeyDown={onPromptKeyDown}
            />
            <span className="text-[9px] text-doom-faint">enter launches · shift+enter for a new line</span>
          </div>
          {workflow.inputs.length === 0 ? null : (
            <div className="flex flex-col gap-2">
              <div className="flex items-center gap-2">
                <FieldLabel>INPUTS</FieldLabel>
                <span className="text-[9px] text-doom-faint">
                  workflow_dispatch · {workflow.inputs.length} declared
                </span>
              </div>
              {workflow.inputs.map((input) => (
                <InputField
                  key={input.name}
                  input={input}
                  value={inputs[input.name] ?? ''}
                  onChange={(next) => setInputs((current) => ({ ...current, [input.name]: next }))}
                />
              ))}
            </div>
          )}
          <div className="flex flex-wrap gap-5">
            <div className="flex flex-col gap-1.5">
              <FieldLabel>RUNNER</FieldLabel>
              {workflow.runners === undefined || workflow.runners.length === 0 ? (
                <span className="flex h-7 items-center text-[10px] text-doom-dim">whatever the workflow resolves</span>
              ) : (
                <Select value={runner} onValueChange={setRunner}>
                  <SelectTrigger
                    data-testid="launch-runner"
                    className="h-7 w-full min-w-0 text-[10px] sm:min-w-[160px]"
                  >
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {workflow.runners.map((choice) => (
                      <SelectItem key={choice} value={choice}>
                        {choice}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              )}
              <span className="text-[9px] text-doom-faint">
                {workflow.runners === undefined ? 'no runner map declared' : 'the runners every step agrees on'}
              </span>
            </div>
            <div className="flex flex-col gap-1.5">
              <FieldLabel>JOBS</FieldLabel>
              <span className="flex h-7 items-center text-[10px] text-doom-dim">
                {workflow.jobs.map((job) => job.name).join(' → ') || 'none declared'}
              </span>
              <span className="text-[9px] text-doom-faint">in the order the file declares them</span>
            </div>
            <div className="flex flex-col gap-1.5">
              <FieldLabel>CWD</FieldLabel>
              <span className="flex h-7 items-center text-[10px] text-doom-dim">{cwd}</span>
              <span className="text-[9px] text-doom-faint">the session's directory</span>
            </div>
          </div>
          <div className="flex flex-col gap-1 rounded-md border border-doom-border bg-doom-deep px-3 py-2">
            <FieldLabel>SENT TO THE SESSION</FieldLabel>
            <pre data-testid="launch-line" className="whitespace-pre-wrap break-words text-[10px] text-doom-green">
              {line}
            </pre>
          </div>
          {problems.length === 0 ? null : (
            <p data-testid="launch-problems" className="text-[10px] text-doom-yellow">
              {problems.join(' ')}
            </p>
          )}
          <DialogFooter className="flex-wrap sm:flex-nowrap">
            <span className="w-full text-[9px] text-doom-faint sm:w-auto">
              the run appears on the board as soon as it starts
            </span>
            <span className="min-w-0 flex-1" />
            <Button variant="outline" size="xs" data-testid="launch-cancel" onClick={onClose}>
              cancel
            </Button>
            <Button
              variant="primary"
              size="xs"
              data-testid="launch-submit"
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
