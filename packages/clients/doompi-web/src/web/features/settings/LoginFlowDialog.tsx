import {
  Button,
  Dialog,
  DialogBody,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  Input,
  Spinner,
} from '@agimon-ai/doompi-web-components';
import { useState } from 'react';

import type { AuthMethodType, LoginEvent, LoginFlowSnapshot, LoginPromptView } from '../../../types/auth';

export const METHOD_LABEL: Readonly<Record<AuthMethodType, string>> = { api_key: 'api key', oauth: 'oauth' };

/** Button's link variant plus the wrapping a full auth URL needs. */
const linkClass = 'inline break-all decoration-doom-blue/40 hover:decoration-doom-blue';

function FlowEvent({ event }: { event: LoginEvent }) {
  if (event.type === 'auth_url') {
    return (
      <div className="flex flex-col gap-1 text-sm text-doom-text">
        <span>open this link to authorize:</span>
        <Button asChild variant="link" size="xs" className={linkClass}>
          <a data-testid="login-flow-auth-url" href={event.url} target="_blank" rel="noreferrer">
            {event.url}
          </a>
        </Button>
        {event.instructions ? <span className="text-doom-dim">{event.instructions}</span> : null}
      </div>
    );
  }
  if (event.type === 'device_code') {
    return (
      <div className="flex flex-col gap-1 text-sm text-doom-text">
        <span>
          enter code{' '}
          <span data-testid="login-flow-device-code" className="font-bold text-doom-hi">
            {event.userCode}
          </span>{' '}
          at{' '}
          <a href={event.verificationUri} target="_blank" rel="noreferrer" className={linkClass}>
            {event.verificationUri}
          </a>
        </span>
      </div>
    );
  }
  if (event.type === 'info') {
    return (
      <div className="flex flex-col gap-1 text-sm text-doom-text">
        <span>{event.message}</span>
        {event.links?.map((link) => (
          <a key={link.url} href={link.url} target="_blank" rel="noreferrer" className={linkClass}>
            {link.label ?? link.url}
          </a>
        ))}
      </div>
    );
  }
  return <span className="text-sm text-doom-dim">{event.message}</span>;
}

function PromptField({
  prompt,
  value,
  remote,
  onChange,
  onSubmit,
  onSelect,
}: {
  prompt: LoginPromptView;
  value: string;
  remote: boolean;
  onChange: (value: string) => void;
  onSubmit: () => void;
  onSelect: (optionId: string) => void;
}) {
  if (prompt.type === 'select') {
    return (
      <div data-testid="login-prompt" data-prompt-type={prompt.type} className="flex flex-col gap-2">
        <span className="text-sm text-doom-text">{prompt.message}</span>
        <div className="flex flex-col gap-1">
          {(prompt.options ?? []).map((option) => (
            <Button
              key={option.id}
              variant="outline"
              data-testid={`login-prompt-option-${option.id}`}
              onClick={() => onSelect(option.id)}
              className="h-auto flex-col items-start gap-0.5 px-2.5 py-1.5 text-left whitespace-normal focus-visible:border-doom-blue/50 focus-visible:ring-0"
            >
              <span className="text-sm text-doom-hi">{option.label}</span>
              {option.description ? <span className="text-xs text-doom-faint">{option.description}</span> : null}
            </Button>
          ))}
        </div>
      </div>
    );
  }
  return (
    <label data-testid="login-prompt" data-prompt-type={prompt.type} className="flex flex-col gap-1">
      <span className="text-sm text-doom-text">{prompt.message}</span>
      {/* The provider redirects to a loopback address that belongs to whichever
          machine the browser runs on, so a remote tab lands on an error page.
          The URL still carries the code, which is what this asks for. */}
      {remote && prompt.type === 'manual_code' ? (
        <span data-testid="login-prompt-remote-hint" className="text-xs text-doom-faint">
          the page it sends you to will not load from here. copy the whole address from your browser's address bar and
          paste it below.
        </span>
      ) : null}
      <div className="flex items-center gap-2">
        <Input
          data-testid="login-prompt-input"
          type={prompt.type === 'secret' ? 'password' : 'text'}
          value={value}
          autoFocus
          autoComplete="off"
          placeholder={prompt.placeholder}
          onChange={(event) => onChange(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter') onSubmit();
          }}
          className="flex-1"
        />
        <Button variant="primary" data-testid="login-prompt-submit" disabled={value.trim() === ''} onClick={onSubmit}>
          continue
        </Button>
      </div>
    </label>
  );
}

/**
 * A provider's login, rendered from the hub's snapshots: the links and codes
 * it announced, the one question it is waiting on, and how it ended.
 */
export function LoginFlowDialog({
  flow,
  onAnswer,
  onCancel,
  onClose,
}: {
  flow: LoginFlowSnapshot;
  onAnswer: (promptId: string, value: string) => void;
  onCancel: () => void;
  onClose: () => void;
}) {
  const [value, setValue] = useState('');
  const prompt = flow.prompt;
  const promptId = prompt?.id;
  const running = flow.status === 'running';

  // A new question starts from an empty field, cleared while rendering the
  // change so the new prompt never paints with the previous answer.
  const [lastPromptId, setLastPromptId] = useState(promptId);
  if (lastPromptId !== promptId) {
    setLastPromptId(promptId);
    setValue('');
  }

  const submit = (): void => {
    if (!prompt || value.trim() === '') return;
    onAnswer(prompt.id, value);
  };

  let outcome: { text: string; className: string } | undefined;
  if (flow.status === 'succeeded')
    outcome = { text: `authenticated with ${flow.providerName}.`, className: 'text-doom-green' };
  else if (flow.status === 'failed') outcome = { text: flow.error ?? 'sign-in failed.', className: 'text-doom-red' };
  else if (flow.status === 'cancelled') outcome = { text: 'sign-in cancelled.', className: 'text-doom-dim' };

  return (
    <Dialog
      open
      onOpenChange={(next) => {
        if (next) return;
        // Escape or an outside click abandons a live sign-in, and simply
        // dismisses a finished one.
        if (running) onCancel();
        else onClose();
      }}
    >
      <DialogContent width="md" data-testid="login-flow" data-status={flow.status} aria-describedby={undefined}>
        <DialogHeader>
          <DialogTitle>sign in to {flow.providerName}</DialogTitle>
          <span className="text-xs text-doom-faint">{METHOD_LABEL[flow.type]}</span>
        </DialogHeader>
        <DialogBody>
          {flow.events.length > 0 ? (
            <ol data-testid="login-flow-events" className="flex flex-col gap-2">
              {flow.events.map((event, index) => (
                <li key={index}>
                  <FlowEvent event={event} />
                </li>
              ))}
            </ol>
          ) : null}
          {running && prompt ? (
            <PromptField
              prompt={prompt}
              value={value}
              remote={flow.remote === true}
              onChange={setValue}
              onSubmit={submit}
              onSelect={(optionId) => onAnswer(prompt.id, optionId)}
            />
          ) : null}
          {running && !prompt ? (
            <p data-testid="login-flow-waiting" className="flex items-center gap-2 text-sm text-doom-dim">
              <Spinner />
              {flow.events.length === 0 ? 'starting…' : `waiting for ${flow.providerName}…`}
            </p>
          ) : null}
          {outcome ? (
            <p data-testid="login-flow-result" className={`text-sm ${outcome.className}`}>
              {outcome.text}
            </p>
          ) : null}
          <DialogFooter>
            {running ? (
              <Button variant="outline" data-testid="login-flow-cancel" onClick={onCancel}>
                cancel
              </Button>
            ) : (
              <Button variant="outline" data-testid="login-flow-close" autoFocus onClick={onClose}>
                close
              </Button>
            )}
          </DialogFooter>
        </DialogBody>
      </DialogContent>
    </Dialog>
  );
}
