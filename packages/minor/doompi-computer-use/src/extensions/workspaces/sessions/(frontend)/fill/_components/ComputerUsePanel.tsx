import type { WebPluginSlotProps } from '@agimon-ai/doompi-core/web';
import { Button } from '@agimon-ai/doompi-web-components';
import { useStore } from '@tanstack/react-store';
import { useEffect, useState } from 'react';

import { api } from '../../../../../../../generated/client';
import { COMPUTER_USE_DEFAULT_DURATION_MS, computerUseChannelType } from '../../../../../../types/computerUseApi';
import { computerUse } from '../../_lib/computerUseStore';

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

  if (sessionId === null) return <p className="px-1 text-xs text-doom-faint">Select a session.</p>;
  const state = session.state;
  const target = session.targets[selected];
  const artifact = state.artifact;
  const confirm = async () => {
    if (confirmationTarget === undefined) return;
    setError(undefined);
    // Through the generated client, which carries the sealed transport: this
    // request names an application window a reader just agreed to hand over,
    // and the global fetch it used to call handed that to a remote session's
    // relay in the clear.
    const result = await api.session(sessionId).activate({
      body: { target: confirmationTarget, durationMs: COMPUTER_USE_DEFAULT_DURATION_MS },
    });
    if (!result.ok) {
      // `status: 0` is the one case nothing answered at all, which the old
      // bare fetch reported by rejecting into nobody's handler.
      if (result.status === 0) setError('The session is unreachable.');
      else setError(result.error === '' ? `Activation failed with HTTP ${result.status}.` : result.error);
      return;
    }
    setConfirmationTarget(undefined);
    send({ action: 'status' });
  };

  return (
    <div data-testid="computer-use-panel" className="flex flex-col gap-2 text-xs text-doom-text">
      <header className="flex items-center justify-between gap-2">
        <span className="text-doom-faint">{state.phase.replaceAll('_', ' ')}</span>
        <Button
          size="sm"
          type="button"
          className="min-h-7 rounded border border-doom-border bg-doom-panel px-2 py-1"
          onClick={() => send({ action: 'targets' })}
        >
          Refresh targets
        </Button>
      </header>
      {session.busy ? (
        <p className="rounded border border-doom-yellow px-2 py-1">Computer use is busy in another session</p>
      ) : null}
      {state.failure ? <p className="text-doom-red">{state.failure.message}</p> : null}
      {error ? <p className="text-doom-red">{error}</p> : null}

      {(state.phase === 'inactive' || state.phase === 'failed') && confirmationTarget === undefined ? (
        <div className="flex flex-col gap-2">
          <label htmlFor="computer-use-target">Application window</label>
          <select
            id="computer-use-target"
            value={selected}
            onChange={(event) => setSelected(Number(event.target.value))}
            className="min-h-7 rounded border border-doom-border bg-doom-panel px-2 py-1"
          >
            {session.targets.map((item, index) => (
              <option key={text(item.windowId, String(index))} value={index}>
                {text(item.applicationName, text(item.windowTitle, text(item.windowId, 'Window')))}
              </option>
            ))}
          </select>
          <Button
            size="sm"
            type="button"
            disabled={!target || Boolean(session.busy)}
            variant="primary"
            onClick={() => target !== undefined && setConfirmationTarget(Object.freeze({ ...target }))}
          >
            Request activation
          </Button>
        </div>
      ) : null}

      {confirmationTarget !== undefined ? (
        <div className="rounded border border-doom-blue p-3">
          <strong>Confirm computer control</strong>
          <p className="my-2 text-doom-text">
            {text(confirmationTarget.applicationName, 'Application')}:{' '}
            {text(confirmationTarget.windowTitle, text(confirmationTarget.windowId, 'Window'))}
          </p>
          <p className="my-2 text-doom-faint">Confirm a 5 minute session for this exact application window.</p>
          <div className="flex gap-2">
            <Button size="sm" type="button" variant="primary" onClick={() => void confirm()}>
              Confirm
            </Button>
            <Button
              size="sm"
              type="button"
              className="min-h-7 rounded border border-doom-border bg-doom-panel px-2 py-1"
              onClick={() => setConfirmationTarget(undefined)}
            >
              Cancel
            </Button>
          </div>
        </div>
      ) : null}

      {state.phase === 'awaiting_confirmation' || state.phase === 'activating' ? (
        <p>Desktop activation is pending.</p>
      ) : null}
      {state.phase === 'active' || state.phase === 'stopping' ? (
        <Button
          size="sm"
          type="button"
          disabled={state.phase === 'stopping'}
          className="min-h-7 rounded border border-doom-border bg-doom-panel px-2 py-1"
          onClick={() => send({ action: 'stop' })}
        >
          Stop computer use
        </Button>
      ) : null}
      {artifact ? (
        <div data-testid="computer-use-artifact" className="rounded bg-doom-panel p-2">
          <strong>{artifact.status === 'ready' ? 'Completed recording' : 'Recording unavailable'}</strong>
          <p>ID: {artifact.artifactId}</p>
          <p>Status: {artifact.status}</p>
          {artifact.failure ? <p className="text-doom-red">{artifact.failure.message}</p> : null}
          {artifact.completedAt ? <p>Completed: {artifact.completedAt}</p> : null}
          {artifact.actionCount !== undefined ? <p>Actions: {artifact.actionCount}</p> : null}
          {artifact.status === 'ready' && artifact.previewUrl ? (
            <video className="mt-2 w-full" controls preload="metadata" src={artifact.previewUrl}>
              <track kind="captions" />
            </video>
          ) : null}
          {artifact.status === 'ready' && artifact.downloadUrl ? (
            <a className="mt-2 inline-block text-doom-blue" href={artifact.downloadUrl} download>
              Download recording
            </a>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
