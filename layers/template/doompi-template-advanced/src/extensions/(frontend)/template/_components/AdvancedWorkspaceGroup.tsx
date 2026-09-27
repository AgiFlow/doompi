import type { WebTemplateRailActions, WebTemplateRailWorkspace } from '@agimon-ai/doompi-core/web';
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
  KebabIcon,
  PlusIcon,
} from '@agimon-ai/doompi-web-components';
import { useState } from 'react';

import { AdvancedSessionCard } from './AdvancedSessionCard';

/** A flat workspace heading over its indented sessions; only a hover tint marks the row. */
export function AdvancedWorkspaceGroup({
  workspace,
  actions,
}: {
  workspace: WebTemplateRailWorkspace;
  actions: WebTemplateRailActions;
}) {
  const [removeOpen, setRemoveOpen] = useState(false);
  const [removeError, setRemoveError] = useState('');
  const [removing, setRemoving] = useState(false);
  const { id, name, root, available, legacy } = workspace;
  const unregister = async (): Promise<void> => {
    setRemoving(true);
    setRemoveError('');
    const result = await actions.deleteWorkspace(id);
    setRemoving(false);
    if (result !== undefined) setRemoveError(result.error);
    else setRemoveOpen(false);
  };
  return (
    <section
      data-testid={`workspace-group-${id}`}
      data-available={available}
      className="border-b border-doom-border/70 py-2 last:border-b-0"
    >
      <div className="flex min-w-0 items-center gap-1 rounded-md px-2 py-1.5 transition-colors hover:bg-doom-panel/60">
        <div className="min-w-0 flex-1 py-0.5">
          <p className="truncate text-sm font-bold text-doom-hi">{name}</p>
          <p className="truncate text-2xs text-doom-faint" title={root}>
            {root}
          </p>
        </div>
        {legacy ? null : (
          <>
            <Button
              variant="ghost"
              size="icon"
              data-testid={`workspace-new-session-${id}`}
              title="new session"
              aria-label={`new session in ${name}`}
              disabled={!available}
              onClick={() => actions.createSession(id)}
              className="text-doom-faint hover:text-doom-hi"
            >
              <PlusIcon className="h-3 w-3" />
            </Button>
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button
                  variant="ghost"
                  size="icon"
                  data-testid={`workspace-menu-${id}`}
                  title="workspace actions"
                  aria-label={`${name} actions`}
                  className="text-doom-faint hover:text-doom-hi"
                >
                  <KebabIcon className="h-3 w-3" />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent>
                <DropdownMenuItem disabled={!available} onSelect={() => actions.resumeInWorkspace(id)}>
                  resume session
                </DropdownMenuItem>
                <DropdownMenuItem disabled={!available} onSelect={() => actions.openWorkspaceSettings(id)}>
                  workspace settings
                </DropdownMenuItem>
                <DropdownMenuItem
                  variant="destructive"
                  data-testid={`workspace-delete-${id}`}
                  onSelect={() => {
                    setRemoveError('');
                    setRemoveOpen(true);
                  }}
                >
                  delete workspace
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </>
        )}
      </div>
      {!available ? <p className="px-8 pt-2 text-2xs text-doom-red">workspace unavailable</p> : null}
      {workspace.sessions.length > 0 ? (
        <div className="mt-1 flex flex-col gap-1 pl-3">
          {workspace.sessions.map((session) => (
            <AdvancedSessionCard key={session.id} session={session} actions={actions} />
          ))}
        </div>
      ) : available ? (
        <p className="px-8 py-2 text-2xs text-doom-faint">no sessions · create or resume one</p>
      ) : null}
      <Dialog open={removeOpen} onOpenChange={(next) => !next && !removing && setRemoveOpen(false)}>
        <DialogContent width="sm" data-testid={`workspace-delete-dialog-${id}`} aria-describedby={undefined}>
          <DialogHeader>
            <DialogTitle>delete workspace</DialogTitle>
          </DialogHeader>
          <DialogBody>
            <DialogDescription>
              this unregisters <span className="font-bold text-doom-hi">{name}</span> from DoomPi only. files at{' '}
              <code>{root}</code> stay on disk. its sessions must be removed first.
            </DialogDescription>
            {removeError ? (
              <p data-testid={`workspace-delete-error-${id}`} className="text-xs text-doom-red">
                {removeError}
              </p>
            ) : null}
            <DialogFooter>
              <Button
                variant="outline"
                size="md"
                data-testid={`workspace-delete-cancel-${id}`}
                disabled={removing}
                autoFocus
                onClick={() => setRemoveOpen(false)}
              >
                cancel
              </Button>
              <Button
                variant="danger"
                size="md"
                data-testid={`workspace-delete-confirm-${id}`}
                disabled={removing}
                onClick={() => void unregister()}
              >
                {removing ? 'deleting…' : 'delete'}
              </Button>
            </DialogFooter>
          </DialogBody>
        </DialogContent>
      </Dialog>
    </section>
  );
}
