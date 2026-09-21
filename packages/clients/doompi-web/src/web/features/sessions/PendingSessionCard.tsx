import {
  Button,
  Dialog,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
  Input,
  KebabIcon,
} from '@agimon-ai/doompi-web-components';
import { useRef, useState } from 'react';

import type { SessionSummary } from '../../../types/hub';
import { PluginSurface } from '../../components/PluginSurface';
import { HOST_SLOTS } from '../../lib/pluginRegistry';
import { removeSessionMcpSetup, setupSessionMcpDirectory } from '../../lib/sessionMcpApi';

type Mode = 'closed' | 'menu' | 'directory';

/** A pending reservation has no runtime and must not inherit live-session actions. */
export function PendingSessionCard({
  parent,
  setup,
}: {
  parent: SessionSummary;
  setup: NonNullable<SessionSummary['pendingSetups']>[number];
}) {
  const [mode, setMode] = useState<Mode>('closed');
  const modeRef = useRef(mode);
  const [cwd, setCwd] = useState(setup.cwd ?? '');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const enter = (next: Mode): void => {
    modeRef.current = next;
    setMode(next);
  };
  const configure = async (): Promise<void> => {
    if (!parent.workspaceId || !cwd.trim() || busy) return;
    setBusy(true);
    setError('');
    const result = await setupSessionMcpDirectory(parent.workspaceId, parent.id, setup.id, cwd.trim());
    setBusy(false);
    if ('error' in result) setError(result.error);
    else enter('closed');
  };
  const remove = async (): Promise<void> => {
    if (!parent.workspaceId || busy) return;
    enter('closed');
    setBusy(true);
    setError('');
    const result = await removeSessionMcpSetup(parent.workspaceId, parent.id, setup.id);
    setBusy(false);
    if ('error' in result) setError(result.error);
  };
  return (
    <div
      data-testid={`pending-session-${setup.id}`}
      className="ml-4 rounded-md border border-doom-border-soft bg-doom-panel p-3"
    >
      <div className="flex items-center justify-between gap-2">
        <span className="truncate text-sm font-bold text-doom-hi">{setup.name}</span>
        <DropdownMenu
          open={mode === 'menu'}
          onOpenChange={(open) => {
            if (open) enter('menu');
            else if (modeRef.current === 'menu') enter('closed');
          }}
        >
          <DropdownMenuTrigger asChild>
            <Button
              variant="ghost"
              size="icon"
              title="session setup actions"
              disabled={busy}
              data-testid={`pending-session-menu-${setup.id}`}
            >
              <KebabIcon className="h-3 w-3" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent
            onCloseAutoFocus={(event) => {
              if (modeRef.current === 'directory') event.preventDefault();
            }}
          >
            <PluginSurface slot={HOST_SLOTS.sessionMenu} sessionId={parent.id} sessionReservationId={setup.id} />
            <DropdownMenuItem onSelect={() => enter('directory')}>choose existing directory…</DropdownMenuItem>
            <DropdownMenuItem variant="destructive" onSelect={() => void remove()}>
              remove setup
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
      <p className="text-xs text-doom-faint">awaiting execution directory</p>
      {setup.cwd ? (
        <p className="truncate text-xs text-doom-dim" title={setup.cwd}>
          {setup.cwd}
        </p>
      ) : null}
      {error ? (
        <p role="alert" className="text-xs text-doom-red">
          {error}
        </p>
      ) : null}
      <Dialog
        open={mode === 'directory'}
        onOpenChange={(open) => {
          if (!open && !busy) enter('closed');
        }}
      >
        <DialogContent width="sm" data-testid={`session-directory-dialog-${setup.id}`}>
          <DialogHeader>
            <DialogTitle>choose execution directory</DialogTitle>
          </DialogHeader>
          <DialogBody>
            <DialogDescription>
              Choose an existing separate checkout. The parent directory and directories used by other sessions are
              refused. A started session cannot be moved. Removing this setup leaves its files untouched.
            </DialogDescription>
            <Input
              aria-label="Execution directory"
              value={cwd}
              disabled={busy}
              autoFocus
              onChange={(event) => setCwd(event.target.value)}
            />
            {error ? (
              <p role="alert" className="text-sm text-doom-red">
                {error}
              </p>
            ) : null}
            <DialogFooter>
              <Button variant="outline" disabled={busy} onClick={() => enter('closed')}>
                cancel
              </Button>
              <Button loading={busy} disabled={!cwd.trim() || !parent.workspaceId} onClick={() => void configure()}>
                create session
              </Button>
            </DialogFooter>
          </DialogBody>
        </DialogContent>
      </Dialog>
    </div>
  );
}
