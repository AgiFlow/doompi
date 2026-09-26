import {
  Button,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
  KebabIcon,
} from '@agimon-ai/doompi-web-components';
import { useRef, useState } from 'react';

import type { SessionSummary } from '../../../types/hub';
import { removeSessionMcpSetup } from '../../lib/sessionMcpApi';

type Mode = 'closed' | 'menu';

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
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const setupType =
    setup.setupKind === 'existing-directory'
      ? 'conversation directory'
      : setup.setupKind === 'managed-worktree'
        ? 'automatic worktree'
        : 'conversation';
  const setupStatus =
    setup.status === 'failed'
      ? `${setupType} setup failed`
      : setup.status === 'interrupted'
        ? `${setupType} setup interrupted`
        : `${setupType} provisioning`;
  const recovery =
    setup.setupKind === undefined && setup.cwd !== undefined
      ? 'This existing setup has no verified provider. Inspect its ownership in DoomPi before retrying.'
      : setup.errorCode === 'SESSION_UNAVAILABLE'
        ? 'The existing session is unavailable. Inspect or resume it in DoomPi before retrying the conversation.'
        : setup.status === 'interrupted'
          ? 'Retry the authenticated conversation to resume this setup. The same setup will be reused.'
          : setup.setupKind === 'existing-directory'
            ? 'Inspect the selected directory, then retry the authenticated conversation. The same setup will be reused.'
            : 'Resolve the Git setup, then retry the authenticated conversation. The same setup will be reused.';
  const enter = (next: Mode): void => {
    modeRef.current = next;
    setMode(next);
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
          <DropdownMenuContent>
            <DropdownMenuItem variant="destructive" onSelect={() => void remove()}>
              remove setup
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
      <p className={setup.status === 'failed' ? 'text-xs text-doom-red' : 'text-xs text-doom-faint'}>{setupStatus}</p>
      {setup.status === 'failed' || setup.status === 'interrupted' ? (
        <p role={setup.status === 'failed' ? 'alert' : undefined} className="text-xs text-doom-faint">
          {recovery}
        </p>
      ) : null}
      {error ? (
        <p role="alert" className="text-xs text-doom-red">
          {error}
        </p>
      ) : null}
    </div>
  );
}
