import type { WebPluginSlotProps } from '@agimon-ai/doompi-web-contracts';
import { useStore } from '@tanstack/react-store';
import { useEffect, useState } from 'react';
import { activationUrl, COMPUTER_USE_DEFAULT_DURATION_MS, computerUseChannelType } from '../types/computerUseApi.ts';
import { computerUse } from './computerUseStore.ts';

function text(value: unknown, fallback: string): string {
  return typeof value === 'string' || typeof value === 'number' ? String(value) : fallback;
}

export function ComputerUsePanel({ sessionId, sendSessionFrame }: WebPluginSlotProps) {
  const session = useStore(computerUse.store, (state) => computerUse.select(state, sessionId));
  const [selected, setSelected] = useState(0);
  const [confirmationTarget, setConfirmationTarget] = useState<Record<string, unknown>>();
  const [error, setError] = useState<string>();
  const send = (payload: Record<string, unknown>) => {
    if (sessionId !== null) sendSessionFrame(sessionId, { type: computerUseChannelType, payload });
  };

  useEffect(() => {
    if (sessionId === null) return;
    sendSessionFrame(sessionId, { type: computerUseChannelType, payload: { action: 'status' } });
    sendSessionFrame(sessionId, { type: computerUseChannelType, payload: { action: 'targets' } });
  }, [sendSessionFrame, sessionId]);

  if (sessionId === null) return <p className="px-1 text-[10px] text-doom-faint">Select a session.</p>;
  const state = session.state;
  const target = session.targets[selected];
  const artifact = state.artifact;
  const confirm = async () => {
    if (confirmationTarget === undefined) return;
    setError(undefined);
    const response = await fetch(activationUrl(sessionId), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ target: confirmationTarget, durationMs: COMPUTER_USE_DEFAULT_DURATION_MS }),
    });
    if (!response.ok) {
      const value = (await response.json()) as { error?: unknown };
      setError(typeof value.error === 'string' ? value.error : `Activation failed with HTTP ${response.status}.`);
      return;
    }
    setConfirmationTarget(undefined);
    send({ action: 'status' });
  };

  return (
    <div data-testid="computer-use-panel" className="flex flex-col gap-2 text-[10px] text-doom-text">
      <header className="flex items-center justify-between gap-2">
        <span className="text-doom-faint">{state.phase.replaceAll('_', ' ')}</span>
        <button type="button" className="rounded bg-doom-panel px-2 py-1" onClick={() => send({ action: 'targets' })}>
          Refresh targets
        </button>
      </header>
      {session.busy ? (
        <p className="rounded border border-doom-warning px-2 py-1">Computer use is busy in another session</p>
      ) : null}
      {state.failure ? <p className="text-doom-error">{state.failure.message}</p> : null}
      {error ? <p className="text-doom-error">{error}</p> : null}

      {(state.phase === 'inactive' || state.phase === 'failed') && confirmationTarget === undefined ? (
        <div className="flex flex-col gap-2">
          <label htmlFor="computer-use-target">Application window</label>
          <select
            id="computer-use-target"
            value={selected}
            onChange={(event) => setSelected(Number(event.target.value))}
            className="rounded bg-doom-panel px-2 py-1"
          >
            {session.targets.map((item, index) => (
              <option key={text(item.windowId, String(index))} value={index}>
                {text(item.applicationName, text(item.windowTitle, text(item.windowId, 'Window')))}
              </option>
            ))}
          </select>
          <button
            type="button"
            disabled={!target || Boolean(session.busy)}
            className="rounded bg-doom-accent px-2 py-1 disabled:opacity-50"
            onClick={() => target !== undefined && setConfirmationTarget(Object.freeze({ ...target }))}
          >
            Request activation
          </button>
        </div>
      ) : null}

      {confirmationTarget !== undefined ? (
        <div className="rounded border border-doom-accent p-3">
          <strong>Confirm computer control</strong>
          <p className="my-2 text-doom-text">
            {text(confirmationTarget.applicationName, 'Application')}:{' '}
            {text(confirmationTarget.windowTitle, text(confirmationTarget.windowId, 'Window'))}
          </p>
          <p className="my-2 text-doom-faint">Confirm a 5 minute session for this exact application window.</p>
          <div className="flex gap-2">
            <button type="button" className="rounded bg-doom-accent px-2 py-1" onClick={() => void confirm()}>
              Confirm
            </button>
            <button
              type="button"
              className="rounded bg-doom-panel px-2 py-1"
              onClick={() => setConfirmationTarget(undefined)}
            >
              Cancel
            </button>
          </div>
        </div>
      ) : null}

      {state.phase === 'awaiting_confirmation' || state.phase === 'activating' ? (
        <p>Desktop activation is pending.</p>
      ) : null}
      {state.phase === 'active' || state.phase === 'stopping' ? (
        <button
          type="button"
          disabled={state.phase === 'stopping'}
          className="rounded bg-doom-panel px-2 py-1"
          onClick={() => send({ action: 'stop' })}
        >
          Stop computer use
        </button>
      ) : null}
      {artifact ? (
        <div data-testid="computer-use-artifact" className="rounded bg-doom-panel p-2">
          <strong>Completed artifact</strong>
          <p>ID: {artifact.artifactId}</p>
          <p>Status: {artifact.status}</p>
          {artifact.completedAt ? <p>Completed: {artifact.completedAt}</p> : null}
          {artifact.actionCount !== undefined ? <p>Actions: {artifact.actionCount}</p> : null}
          {artifact.previewUrl ? <a href={artifact.previewUrl}>Preview</a> : null}
          {artifact.downloadUrl ? <a href={artifact.downloadUrl}>Download</a> : null}
        </div>
      ) : null}
    </div>
  );
}
