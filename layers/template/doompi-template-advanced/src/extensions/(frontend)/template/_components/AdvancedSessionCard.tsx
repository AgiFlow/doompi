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
  Input,
  KebabIcon,
} from '@agimon-ai/doompi-web-components';
import { useRef, useState } from 'react';

import { AdvancedPendingSetup } from './AdvancedPendingSetup';

/**
 * What the card is doing besides showing its session: nothing, showing its
 * action menu, taking a new name, or asking before a remove.
 */
type CardMode = 'view' | 'menu' | 'rename' | 'confirm';

export function AdvancedSessionCard({
  session,
  actions,
}: {
  session: WebTemplateRailSession;
  actions: WebTemplateRailActions;
}) {
  const [mode, setMode] = useState<CardMode>('view');
  const [draft, setDraft] = useState('');
  const [removeError, setRemoveError] = useState('');
  // Read when the menu closes: a choice that moved the card into another mode
  // keeps the focus it took, rather than handing it back to the kebab. The
  // menu's close-focus handler runs before React re-renders the card, so the
  // ref is written by the event that changes the mode, never during render.
  const modeRef = useRef(mode);
  const enterMode = (next: CardMode): void => {
    modeRef.current = next;
    setMode(next);
  };
  const { active } = session;
  const error = removeError || session.error;
  const cardClass = active ? 'bg-doom-selected hover:bg-doom-selected' : 'hover:bg-doom-panel';
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

  const details = (
    <>
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
          className={`text-sm leading-snug ${session.awaitingInput ? 'text-doom-red' : active ? 'line-clamp-2 text-doom-on-selected/85' : 'truncate text-doom-dim'}`}
        >
          {session.status}
        </span>
      </span>
      {session.git ? (
        <span
          data-testid="session-branch"
          className={`flex items-center gap-[7px] pt-0.5 text-xs ${active ? 'text-doom-on-selected/85' : 'text-doom-faint'}`}
        >
          <BranchIcon
            className={`h-[10px] w-[10px] shrink-0 ${active ? 'text-doom-on-selected' : 'text-doom-faint'}`}
          />
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
    </>
  );

  const heading = (
    <div className="flex items-center gap-2">
      {session.nested && session.provenance ? (
        <ForkIcon
          aria-label={session.provenance === 'worktree' ? 'automatic per-conversation worktree' : session.provenance}
          className={`h-[11px] w-[11px] shrink-0 ${active ? 'text-doom-on-selected' : 'text-doom-faint'}`}
        />
      ) : null}
      {session.profile ? (
        <Avatar
          data-testid="session-avatar"
          aria-label={session.profile.label}
          title={session.profile.label}
          className="h-5 w-5 shrink-0 border border-doom-border-soft bg-doom-deep"
        >
          {session.profile.avatarUrl ? <AvatarImage src={session.profile.avatarUrl} alt="" /> : null}
          <AvatarFallback className="text-2xs text-doom-magenta">{session.profile.initials}</AvatarFallback>
        </Avatar>
      ) : null}
      <span
        className={`min-w-0 flex-1 truncate text-base font-bold ${active ? 'text-doom-on-selected' : 'text-doom-hi'}`}
      >
        {session.name || 'untitled'}
      </span>
      {session.ordinal <= 9 ? (
        <span
          title={`press ${String(session.ordinal)} to focus`}
          className={`flex h-[17px] w-[17px] shrink-0 items-center justify-center rounded-full text-2xs font-bold transition-opacity group-focus-within:opacity-0 group-hover:opacity-0 ${
            active ? 'bg-doom-deep/20 text-doom-on-selected' : 'bg-doom-tint-magenta text-doom-magenta'
          }`}
        >
          {session.ordinal}
        </span>
      ) : null}
    </div>
  );

  const menuOpen = mode === 'menu';
  return (
    <>
      <div
        className={cn('group relative', session.nested && 'pl-3')}
        data-testid={`session-card-${session.id}`}
        data-active={active}
        data-nested={session.nested}
      >
        <Button
          variant="ghost"
          size="card"
          data-testid={`session-open-${session.id}`}
          onClick={() => actions.openSession(session.id)}
          className={cardClass}
        >
          {heading}
          {details}
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
                  className={
                    active
                      ? 'text-doom-on-selected/80 hover:bg-doom-on-selected/20 hover:text-doom-on-selected data-[state=open]:bg-doom-on-selected/20 data-[state=open]:text-doom-on-selected'
                      : 'text-doom-faint hover:bg-doom-deep hover:text-doom-hi data-[state=open]:bg-doom-deep data-[state=open]:text-doom-hi'
                  }
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
                from the rail. anything it is running ends now, but its saved history remains available to resume.
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
        <AdvancedPendingSetup key={`setup:${setup.id}`} sessionId={session.id} setup={setup} actions={actions} />
      ))}
    </>
  );
}
