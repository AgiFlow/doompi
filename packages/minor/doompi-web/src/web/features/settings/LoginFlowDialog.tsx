import { useEffect, useState } from 'react';
import type { AuthMethodType, LoginEvent, LoginFlowSnapshot, LoginPromptView } from '../../../types/auth.ts';

export const METHOD_LABEL: Readonly<Record<AuthMethodType, string>> = { api_key: 'api key', oauth: 'oauth' };

const linkClass = 'break-all text-doom-blue underline decoration-doom-blue/40 hover:decoration-doom-blue';
const buttonClass = 'rounded border border-doom-border px-3 py-1 text-[11px] text-doom-dim hover:text-doom-hi';
const primaryClass = 'rounded bg-doom-blue px-3 py-1 text-[11px] font-bold text-doom-rail disabled:opacity-40';

function FlowEvent({ event }: { event: LoginEvent }) {
  if (event.type === 'auth_url') {
    return (
      <div className="flex flex-col gap-1 text-[11px] text-doom-text">
        <span>open this link to authorize:</span>
        <a data-testid="login-flow-auth-url" href={event.url} target="_blank" rel="noreferrer" className={linkClass}>
          {event.url}
        </a>
        {event.instructions ? <span className="text-doom-dim">{event.instructions}</span> : null}
      </div>
    );
  }
  if (event.type === 'device_code') {
    return (
      <div className="flex flex-col gap-1 text-[11px] text-doom-text">
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
      <div className="flex flex-col gap-1 text-[11px] text-doom-text">
        <span>{event.message}</span>
        {event.links?.map((link) => (
          <a key={link.url} href={link.url} target="_blank" rel="noreferrer" className={linkClass}>
            {link.label ?? link.url}
          </a>
        ))}
      </div>
    );
  }
  return <span className="text-[11px] text-doom-dim">{event.message}</span>;
}

function PromptField({
  prompt,
  value,
  onChange,
  onSubmit,
  onSelect,
}: {
  prompt: LoginPromptView;
  value: string;
  onChange: (value: string) => void;
  onSubmit: () => void;
  onSelect: (optionId: string) => void;
}) {
  if (prompt.type === 'select') {
    return (
      <div data-testid="login-prompt" data-prompt-type={prompt.type} className="flex flex-col gap-2">
        <span className="text-[11px] text-doom-text">{prompt.message}</span>
        <div className="flex flex-col gap-1">
          {(prompt.options ?? []).map((option) => (
            <button
              key={option.id}
              type="button"
              data-testid={`login-prompt-option-${option.id}`}
              onClick={() => onSelect(option.id)}
              className="flex flex-col items-start gap-0.5 rounded border border-doom-border px-2.5 py-1.5 text-left hover:border-doom-blue/50"
            >
              <span className="text-[11px] text-doom-hi">{option.label}</span>
              {option.description ? <span className="text-[10px] text-doom-faint">{option.description}</span> : null}
            </button>
          ))}
        </div>
      </div>
    );
  }
  return (
    <label data-testid="login-prompt" data-prompt-type={prompt.type} className="flex flex-col gap-1">
      <span className="text-[11px] text-doom-text">{prompt.message}</span>
      <div className="flex items-center gap-2">
        <input
          data-testid="login-prompt-input"
          type={prompt.type === 'secret' ? 'password' : 'text'}
          value={value}
          autoFocus
          spellCheck={false}
          autoComplete="off"
          placeholder={prompt.placeholder}
          onChange={(event) => onChange(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter') onSubmit();
          }}
          className="min-w-0 flex-1 rounded border border-doom-border bg-doom-deep px-2.5 py-1.5 text-[12px] text-doom-hi outline-none placeholder:text-doom-faint focus:border-doom-blue/60"
        />
        <button
          type="button"
          data-testid="login-prompt-submit"
          disabled={value.trim() === ''}
          onClick={onSubmit}
          className={primaryClass}
        >
          continue
        </button>
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

  // A new question starts from an empty field.
  useEffect(() => {
    setValue('');
  }, [promptId]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape') return;
      if (running) onCancel();
      else onClose();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [running, onCancel, onClose]);

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
    <div className="fixed inset-0 z-20 flex items-center justify-center bg-doom-deep/70">
      <div
        role="dialog"
        aria-modal
        data-testid="login-flow"
        data-status={flow.status}
        className="w-[480px] overflow-hidden rounded-lg border border-doom-border bg-doom-panel shadow-2xl"
      >
        <div className="flex items-center justify-between border-b border-doom-border px-4 py-3">
          <span className="text-[12px] font-bold tracking-wide text-doom-hi">sign in to {flow.providerName}</span>
          <span className="text-[10px] text-doom-faint">{METHOD_LABEL[flow.type]}</span>
        </div>
        <div className="flex flex-col gap-3 px-4 py-4">
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
              onChange={setValue}
              onSubmit={submit}
              onSelect={(optionId) => onAnswer(prompt.id, optionId)}
            />
          ) : null}
          {running && !prompt ? (
            <p data-testid="login-flow-waiting" className="text-[11px] text-doom-dim">
              {flow.events.length === 0 ? 'starting…' : `waiting for ${flow.providerName}…`}
            </p>
          ) : null}
          {outcome ? (
            <p data-testid="login-flow-result" className={`text-[11px] ${outcome.className}`}>
              {outcome.text}
            </p>
          ) : null}
          <div className="flex items-center justify-end gap-2">
            {running ? (
              <button type="button" data-testid="login-flow-cancel" onClick={onCancel} className={buttonClass}>
                cancel
              </button>
            ) : (
              <button type="button" data-testid="login-flow-close" autoFocus onClick={onClose} className={buttonClass}>
                close
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
