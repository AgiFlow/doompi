import {
  AlertIcon,
  BranchIcon,
  Button,
  buttonVariants,
  CloseIcon,
  cn,
  Dot,
  ForkIcon,
  PlusIcon,
  SectionLabel,
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '@agimon-ai/doompi-web-components';
import type { ReactNode } from 'react';

import type { RemoteAccessStateView } from '../../../types/remoteAccess';
import { abbreviateCwd } from '../../lib/sessionSummary';
import type { SessionMeta } from '../../stores/sessionsStore';

export interface SessionCardViewProps {
  meta: SessionMeta;
  ordinal: number;
  active: boolean;
  status: string;
  awaitingInput?: boolean;
  restarting?: boolean;
  error?: string;
  nested?: boolean;
  onOpen?: () => void;
  editing?: ReactNode;
  menu?: ReactNode;
}

export function SessionCardView({
  meta,
  ordinal,
  active,
  status,
  awaitingInput = false,
  restarting = false,
  error,
  nested = false,
  onOpen,
  editing,
  menu,
}: SessionCardViewProps) {
  const summary = meta.summary;
  const cardClass = active ? 'bg-doom-selected hover:bg-doom-selected' : 'hover:bg-doom-panel';
  const details = (
    <>
      <span className="flex items-start gap-1">
        {awaitingInput ? (
          <AlertIcon
            data-testid="session-awaiting-input"
            aria-label="waiting for your input"
            className="mt-[2px] h-[11px] w-[11px] shrink-0 text-doom-red"
          />
        ) : null}
        <span
          data-testid="session-status"
          className={`text-sm leading-snug ${awaitingInput ? 'text-doom-red' : active ? 'line-clamp-2 text-doom-on-selected/85' : 'truncate text-doom-dim'}`}
        >
          {restarting ? 'restarting…' : status}
        </span>
      </span>
      {summary.git ? (
        <span
          data-testid="session-branch"
          className={`flex items-center gap-[7px] pt-0.5 text-xs ${active ? 'text-doom-on-selected/85' : 'text-doom-faint'}`}
        >
          <BranchIcon
            className={`h-[10px] w-[10px] shrink-0 ${active ? 'text-doom-on-selected/70' : 'text-doom-faint'}`}
          />
          {summary.git.branch}
          {summary.git.dirty ? '*' : ''}
        </span>
      ) : null}
      {nested ? null : (
        <span className={`truncate text-xs ${active ? 'text-doom-on-selected/70' : 'text-doom-faint'}`}>
          {abbreviateCwd(summary.cwd)}
        </span>
      )}
      {error ? (
        <span data-testid="session-error" className="line-clamp-3 text-xs break-words text-doom-red">
          {error}
        </span>
      ) : null}
    </>
  );

  return (
    <div
      className={cn('group relative', nested && 'pl-3')}
      data-testid={`session-card-${summary.id}`}
      data-active={active}
      data-nested={nested}
    >
      {editing !== undefined ? (
        <div className={cn(buttonVariants({ variant: 'ghost', size: 'card' }), cardClass, 'cursor-default')}>
          {editing}
          {details}
        </div>
      ) : (
        <Button
          variant="ghost"
          size="card"
          data-testid={`session-open-${summary.id}`}
          onClick={onOpen}
          className={cardClass}
        >
          <div className="flex items-center gap-2">
            {nested && summary.sessionProvenance ? (
              <ForkIcon
                aria-label={summary.sessionProvenance}
                className={`h-[11px] w-[11px] shrink-0 ${active ? 'text-doom-on-selected/70' : 'text-doom-faint'}`}
              />
            ) : null}
            <span
              className={`min-w-0 flex-1 truncate text-base font-bold ${active ? 'text-doom-on-selected' : 'text-doom-hi'}`}
            >
              {summary.name || 'untitled'}
            </span>
            {ordinal <= 9 ? (
              <span
                title={`press ${String(ordinal)} to focus`}
                className={`flex h-[17px] w-[17px] shrink-0 items-center justify-center rounded-full text-2xs font-bold transition-opacity group-focus-within:opacity-0 group-hover:opacity-0 ${
                  active ? 'bg-doom-on-selected/20 text-doom-on-selected' : 'bg-doom-tint-magenta text-doom-magenta'
                }`}
              >
                {ordinal}
              </span>
            ) : null}
          </div>
          {details}
        </Button>
      )}
      {menu}
    </div>
  );
}

export interface SessionRailViewProps {
  hasSessions: boolean;
  cards: ReactNode;
  remote?: RemoteAccessStateView;
  remoteAccessButton: ReactNode;
  railContent?: ReactNode;
  settingsLink: ReactNode;
  children?: ReactNode;
  onDismiss?: () => void;
  onOpenRemote: () => void;
  onOpenNewSession: () => void;
  onTurnRemoteOff: () => void;
}

export function SessionRailView({
  hasSessions,
  cards,
  remote,
  remoteAccessButton,
  railContent,
  settingsLink,
  children,
  onDismiss,
  onOpenRemote,
  onOpenNewSession,
  onTurnRemoteOff,
}: SessionRailViewProps) {
  return (
    <div className="flex h-full flex-col">
      <div
        data-doompi-session-rail-header
        className="flex items-center justify-between border-b border-doom-border px-4 pt-4 pb-3.5"
      >
        <span className="flex items-center gap-[3px]" aria-label="DoomPi">
          <span aria-hidden="true" className="text-lg font-bold tracking-wider text-doom-hi">
            DOOM
          </span>
          <span aria-hidden="true" className="text-lg leading-none text-doom-magenta">
            ♟
          </span>
        </span>
        <span className="flex items-center gap-1">
          {remoteAccessButton}
          {onDismiss ? (
            <Button
              variant="ghost"
              size="icon"
              data-testid="mobile-sessions-close"
              title="hide sessions"
              aria-label="hide sessions"
              onClick={onDismiss}
              className="text-doom-dim md:hidden"
            >
              <CloseIcon className="h-3 w-3" />
            </Button>
          ) : null}
        </span>
      </div>

      <div className="flex items-center justify-between px-4 pt-3.5 pb-2">
        <SectionLabel>sessions</SectionLabel>
        <span className="flex items-center gap-2.5">
          <Button
            variant="ghost"
            size="icon"
            data-testid="new-session-open"
            title="new session"
            aria-label="new session"
            onClick={onOpenNewSession}
            className="text-doom-faint hover:text-doom-hi"
          >
            <PlusIcon className="h-3 w-3" />
          </Button>
        </span>
      </div>
      <div className="flex flex-col gap-1 px-2.5">{cards}</div>
      {!hasSessions ? (
        <div className="px-2.5 pt-2">
          <Button
            variant="outline"
            size="lg"
            data-testid="new-session-empty"
            onClick={onOpenNewSession}
            className="w-full justify-start px-[11px] text-sm"
          >
            <PlusIcon className="h-3 w-3" />
            new session
          </Button>
        </div>
      ) : null}

      {railContent}
      <div className="flex-1" />
      <div className="sticky bottom-0 mt-auto shrink-0 bg-doom-rail">
        {remote === undefined || remote.status === 'off' ? null : (
          <div
            data-testid="remote-banner"
            className={`flex flex-col gap-1.5 border-t px-4 py-2 text-sm ${
              remote.status === 'failed' ? 'bg-doom-tint-red text-doom-red' : 'bg-doom-tint-yellow text-doom-yellow'
            }`}
          >
            <output className="flex min-w-0 items-center gap-2">
              <Dot tone={remote.status === 'failed' ? 'red' : 'yellow'} />
              <span className="truncate">
                {remote.status === 'failed'
                  ? `remote access failed: ${remote.error ?? 'the tunnel stopped'}`
                  : `remote access is ${remote.status === 'starting' ? 'starting' : 'on'}${
                      remote.publicUrl === undefined ? '' : ` · ${new URL(remote.publicUrl).host}`
                    } · ${String(remote.devices.length)} device${remote.devices.length === 1 ? '' : 's'} paired`}
              </span>
            </output>
            <span className="flex items-center justify-end gap-1">
              <Button variant="ghost" size="sm" data-testid="remote-banner-open" onClick={onOpenRemote}>
                manage
              </Button>
              <Button variant="ghost" size="sm" data-testid="remote-banner-off" onClick={onTurnRemoteOff}>
                turn off
              </Button>
            </span>
          </div>
        )}
        <div className="flex items-center gap-2.5 border-t border-doom-border px-4 py-3">
          <Tooltip>
            <TooltipTrigger asChild>{settingsLink}</TooltipTrigger>
            <TooltipContent side="top">settings</TooltipContent>
          </Tooltip>
          <span className="text-2xs text-doom-faint max-sm:hidden">ctrl+k commands · ctrl+t new session</span>
        </div>
      </div>
      {children}
    </div>
  );
}
