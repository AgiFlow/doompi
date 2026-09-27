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

import { ElegantSessionCard } from './ElegantSessionCard';

/** A small-caps workspace label; its path lives in the tooltip and its actions appear on hover. */
export function ElegantWorkspaceGroup({
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
    <section data-testid={`workspace-group-${id}`} data-available={available} className="flex flex-col gap-1.5 pt-4">
      <div className="group/workspace flex min-w-0 items-center gap-1 px-1">
        <p
          className="min-w-0 flex-1 truncate text-2xs font-bold tracking-widest text-doom-faint uppercase"
          title={root}
        >
          {name}
        </p>
        {legacy ? null : (
          <span className="flex items-center gap-0.5 opacity-0 transition-opacity group-focus-within/workspace:opacity-100 group-hover/workspace:opacity-100">
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
          </span>
        )}
      </div>
      {!available ? <p className="px-1 text-2xs text-doom-red">workspace unavailable</p> : null}
      {workspace.sessions.length > 0 ? (
        <div className="flex flex-col gap-1.5">
          {workspace.sessions.map((session) => (
            <ElegantSessionCard key={session.id} session={session} actions={actions} />
          ))}
        </div>
      ) : available ? (
        <p className="px-1 text-2xs text-doom-faint">no sessions yet</p>
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
