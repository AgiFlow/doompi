import type { WebTemplateRailActions, WebTemplateRailSession } from '@agimon-ai/doompi-core/web';
import {
  AlertIcon,
  Avatar,
  AvatarFallback,
  AvatarImage,
  BranchIcon,
  Button,
  cn,
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
  ForkIcon,
  ActivityIcon,
  Input,
  KebabIcon,
} from '@agimon-ai/doompi-web-components';
import { useRef, useState } from 'react';

import { ElegantPendingSetup } from './ElegantPendingSetup';

type CardMode = 'view' | 'menu' | 'rename' | 'confirm';

/** A soft tile led by the persona avatar, with the branch as a quiet caption. */
export function ElegantSessionCard({
  session,
  actions,
}: {
  session: WebTemplateRailSession;
  actions: WebTemplateRailActions;
}) {
  const [mode, setMode] = useState<CardMode>('view');
  const [draft, setDraft] = useState('');
  const [removeError, setRemoveError] = useState('');
  // Written by the event that changes the mode, so the menu's close-focus handler
  // sees the new mode before React re-renders the card.
  const modeRef = useRef(mode);
  const enterMode = (next: CardMode): void => {
    modeRef.current = next;
    setMode(next);
  };
  const { active } = session;
  const error = removeError || session.error;
  const tileClass = active
    ? 'rounded-lg bg-doom-selected hover:bg-doom-selected'
    : 'rounded-lg bg-doom-panel/40 hover:bg-doom-panel';
  const commitRename = (): void => {
    actions.renameSession(session.id, draft);
    enterMode('view');
  };
  const remove = async (): Promise<void> => {
    enterMode('view');
    setRemoveError('');
    const result = await actions.removeSession(session.id);
    if (result !== undefined) setRemoveError(result.error);
  };

  const body = (
    <div className="flex items-start gap-2.5">
      <Avatar
        data-testid={session.profile ? 'session-avatar' : undefined}
        aria-label={session.profile?.label ?? 'DoomPi'}
        title={session.profile?.label}
        className="mt-0.5 h-7 w-7 shrink-0 border border-doom-border-soft bg-doom-deep"
      >
        {session.profile?.avatarUrl ? <AvatarImage src={session.profile.avatarUrl} alt="" /> : null}
        <AvatarFallback className="text-2xs text-doom-magenta">{session.profile?.initials ?? 'DP'}</AvatarFallback>
      </Avatar>
      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
        <div className="flex items-center gap-1.5">
          {session.nested && session.provenance === 'workflow-session' ? (
            <ActivityIcon
              aria-label="workflow session"
              className={`h-[11px] w-[11px] shrink-0 ${active ? 'text-doom-on-selected' : 'text-doom-faint'}`}
            />
          ) : session.nested && session.provenance ? (
            <ForkIcon
              aria-label={
                session.provenance === 'worktree' ? 'automatic per-conversation worktree' : session.provenance
              }
              className={`h-[11px] w-[11px] shrink-0 ${active ? 'text-doom-on-selected' : 'text-doom-faint'}`}
            />
          ) : null}
          <span
            className={`min-w-0 flex-1 truncate text-sm font-bold ${active ? 'text-doom-on-selected' : 'text-doom-hi'}`}
          >
            {session.name || 'untitled'}
          </span>
          {session.ordinal <= 9 ? (
            <span
              title={`press ${String(session.ordinal)} to focus`}
              className={`shrink-0 text-2xs transition-opacity group-focus-within:opacity-0 group-hover:opacity-0 ${
                active ? 'text-doom-on-selected/70' : 'text-doom-faint'
              }`}
            >
              {session.ordinal}
            </span>
          ) : null}
        </div>
        <span className="flex items-start gap-1">
          {session.awaitingInput ? (
            <AlertIcon
              data-testid="session-awaiting-input"
              aria-label="waiting for your input"
              className="mt-[2px] h-[11px] w-[11px] shrink-0 text-doom-red"
            />
          ) : null}
          <span
            data-testid="session-status"
            className={`truncate text-xs ${session.awaitingInput ? 'text-doom-red' : active ? 'text-doom-on-selected/80' : 'text-doom-dim'}`}
          >
            {session.status}
          </span>
        </span>
        {session.git ? (
          <span
            data-testid="session-branch"
            className={`flex items-center gap-1.5 text-2xs ${active ? 'text-doom-on-selected/70' : 'text-doom-faint'}`}
          >
            <BranchIcon className="h-[9px] w-[9px] shrink-0" />
            <span className="truncate">
              {session.git.branch}
              {session.git.dirty ? '*' : ''}
            </span>
          </span>
        ) : null}
        {error ? (
          <span data-testid="session-error" className="line-clamp-3 text-xs break-words text-doom-red">
            {error}
          </span>
        ) : null}
      </div>
    </div>
  );

  const menuOpen = mode === 'menu';
  return (
    <>
      <div
        className={cn('group relative', session.nested && 'pl-4')}
        data-testid={`session-card-${session.id}`}
        data-active={active}
        data-nested={session.nested}
      >
        <Button
          variant="ghost"
          size="card"
          data-testid={`session-open-${session.id}`}
          onClick={() => actions.openSession(session.id)}
          className={tileClass}
        >
          {body}
        </Button>
        {mode === 'view' || menuOpen ? (
          <div
            className={`absolute top-2 right-2 transition-opacity ${
              menuOpen ? 'opacity-100' : 'opacity-0 group-focus-within:opacity-100 group-hover:opacity-100'
            }`}
          >
            <DropdownMenu
              open={menuOpen}
              onOpenChange={(next) => {
                const current = modeRef.current;
                enterMode(next ? 'menu' : current === 'menu' ? 'view' : current);
              }}
            >
              <DropdownMenuTrigger asChild>
                <Button
                  variant="ghost"
                  size="icon"
                  data-testid={`session-menu-${session.id}`}
                  title="session actions"
                  className={active ? 'text-doom-on-selected/80' : 'text-doom-faint hover:text-doom-hi'}
                >
                  <KebabIcon className="h-3 w-3" />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent
                data-testid={`session-menu-list-${session.id}`}
                onCloseAutoFocus={(event) => {
                  if (modeRef.current !== 'view') event.preventDefault();
                }}
              >
                {actions.renderSessionMenuItems(session.id)}
                <DropdownMenuItem
                  data-testid={`session-rename-${session.id}`}
                  onSelect={() => {
                    setDraft(session.name);
                    enterMode('rename');
                  }}
                >
                  rename
                </DropdownMenuItem>
                <DropdownMenuItem
                  data-testid={`session-resume-${session.id}`}
                  onSelect={() => actions.resumeSession(session.id)}
                >
                  resume
                </DropdownMenuItem>
                <DropdownMenuItem
                  data-testid={`session-restart-${session.id}`}
                  disabled={session.restarting}
                  onSelect={() => actions.restartSession(session.id)}
                >
                  restart
                </DropdownMenuItem>
                <DropdownMenuItem
                  variant="destructive"
                  data-testid={`session-stop-${session.id}`}
                  onSelect={() => enterMode('confirm')}
                >
                  remove
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
        ) : null}
        <Dialog open={mode === 'rename'} onOpenChange={(next) => !next && enterMode('view')}>
          <DialogContent width="sm" data-testid={`session-rename-dialog-${session.id}`} aria-describedby={undefined}>
            <DialogHeader>
              <DialogTitle>rename session</DialogTitle>
            </DialogHeader>
            <DialogBody>
              <form
                className="flex flex-col gap-3"
                onSubmit={(event) => {
                  event.preventDefault();
                  commitRename();
                }}
              >
                <Input
                  data-testid={`session-name-input-${session.id}`}
                  aria-label="session name"
                  value={draft}
                  autoFocus
                  onChange={(event) => setDraft(event.target.value)}
                />
                <DialogFooter>
                  <Button
                    type="button"
                    variant="outline"
                    size="md"
                    data-testid={`session-rename-cancel-${session.id}`}
                    onClick={() => enterMode('view')}
                  >
                    cancel
                  </Button>
                  <Button
                    type="submit"
                    variant="primary"
                    size="md"
                    data-testid={`session-rename-confirm-${session.id}`}
                    disabled={draft.trim() === ''}
                  >
                    rename
                  </Button>
                </DialogFooter>
              </form>
            </DialogBody>
          </DialogContent>
        </Dialog>
        <Dialog open={mode === 'confirm'} onOpenChange={(next) => !next && enterMode('view')}>
          <DialogContent width="sm" data-testid={`session-stop-dialog-${session.id}`} aria-describedby={undefined}>
            <DialogHeader>
              <DialogTitle>remove session</DialogTitle>
            </DialogHeader>
            <DialogBody>
              <DialogDescription>
                this stops <span className="font-bold text-doom-hi">{session.name || 'untitled'}</span> and removes it
                from the list. anything it is running ends now, but its saved history remains available to resume.
              </DialogDescription>
              <DialogFooter>
                <Button
                  variant="outline"
                  size="md"
                  data-testid={`session-stop-cancel-${session.id}`}
                  autoFocus
                  onClick={() => enterMode('view')}
                >
                  cancel
                </Button>
                <Button
                  variant="danger"
                  size="md"
                  data-testid={`session-stop-confirm-${session.id}`}
                  onClick={() => void remove()}
                >
                  remove
                </Button>
              </DialogFooter>
            </DialogBody>
          </DialogContent>
        </Dialog>
      </div>
      {session.pendingSetups.map((setup) => (
        <ElegantPendingSetup key={`setup:${setup.id}`} sessionId={session.id} setup={setup} actions={actions} />
      ))}
    </>
  );
}
