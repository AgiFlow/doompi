import {
  Button,
  Dialog,
  DialogBody,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  Input,
} from '@agimon-ai/doompi-web-components';
import { useNavigate } from '@tanstack/react-router';
import { useState } from 'react';

import { createWorkspaceSession } from '../../lib/hubApi';
import { applySessionUpsert, waitForSession } from '../../stores/sessionsStore';

/** Creates a session directly in an already admitted workspace. */
export function NewSessionDialog({
  workspaceId,
  workspaceRoot,
  onClose,
}: {
  workspaceId: string;
  workspaceRoot: string;
  onClose: () => void;
}) {
  const navigate = useNavigate();
  const [name, setName] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const submit = async (): Promise<void> => {
    if (busy) return;
    setBusy(true);
    setError('');
    const outcome = await createWorkspaceSession(workspaceId, { name: name.trim() || undefined });
    if ('sessionId' in outcome) {
      if (outcome.session !== undefined) applySessionUpsert({ session: outcome.session });
      const appeared = await waitForSession(outcome.sessionId);
      if (appeared) {
        onClose();
        await navigate({ to: '/session/$sessionId', params: { sessionId: outcome.sessionId } });
        return;
      }
      setError('The session was created but has not appeared yet; it will show up in the rail.');
      setBusy(false);
      return;
    }
    setError(outcome.error);
    setBusy(false);
  };

  return (
    <Dialog open onOpenChange={(next) => !next && !busy && onClose()}>
      <DialogContent width="md" data-testid="new-session-dialog" aria-describedby={undefined}>
        <DialogHeader>
          <DialogTitle>new session</DialogTitle>
        </DialogHeader>
        <DialogBody>
          <p className="truncate text-xs text-doom-faint" title={workspaceRoot}>
            {workspaceRoot}
          </p>
          <label htmlFor="new-session-name" className="flex flex-col gap-1">
            <span className="text-xs text-doom-faint">name (optional)</span>
            <Input
              id="new-session-name"
              data-testid="new-session-name"
              value={name}
              autoFocus
              onChange={(event) => setName(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter') void submit();
              }}
              placeholder="session name"
            />
          </label>
          {error ? (
            <pre
              data-testid="new-session-error"
              className="max-h-28 overflow-y-auto rounded border border-doom-edge-red bg-doom-tint-red/40 px-2.5 py-2 text-xs leading-relaxed whitespace-pre-wrap break-words text-doom-red"
            >
              {error}
            </pre>
          ) : null}
          <DialogFooter>
            <Button variant="outline" data-testid="new-session-cancel" onClick={onClose} disabled={busy}>
              cancel
            </Button>
            <Button variant="primary" data-testid="new-session-create" onClick={() => void submit()} disabled={busy}>
              {busy ? 'creating…' : 'create'}
            </Button>
          </DialogFooter>
        </DialogBody>
      </DialogContent>
    </Dialog>
  );
}
