import type { WebTemplateRail } from '@agimon-ai/doompi-core/web';
import {
  Button,
  CloseIcon,
  Dot,
  GearIcon,
  PlusIcon,
  SectionLabel,
  ShieldIcon,
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '@agimon-ai/doompi-web-components';

import { AdvancedWorkspaceGroup } from './AdvancedWorkspaceGroup';

/** The persistent session rail: workspaces with their sessions, remote access, and settings. */
export function AdvancedRail({ rail, onClose }: { rail: WebTemplateRail; onClose: () => void }) {
  const { remote, actions } = rail;
  const live = remote.status === 'on' || remote.status === 'starting';
  const remoteDetail =
    remote.status === 'on'
      ? `remote access on, ${String(remote.deviceCount)} device${remote.deviceCount === 1 ? '' : 's'} paired`
      : undefined;
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
          <Button
            variant={live ? 'primary' : remote.status === 'failed' ? 'danger-outline' : 'outline'}
            size="sm"
            data-testid="remote-access-open"
            title={remoteDetail ?? 'remote access'}
            aria-label={remoteDetail ?? `remote access is ${remote.status}`}
            onClick={actions.openRemoteAccess}
            className="gap-1.5"
          >
            {live ? <Dot tone="yellow" pulse data-testid="remote-access-live" /> : <ShieldIcon className="h-3 w-3" />}
            remote access
          </Button>
          <Button
            variant="ghost"
            size="icon"
            data-testid="mobile-sessions-close"
            title="hide sessions"
            aria-label="hide sessions"
            onClick={onClose}
            className="text-doom-dim md:hidden"
          >
            <CloseIcon className="h-3 w-3" />
          </Button>
        </span>
      </div>

      <div className="flex items-center justify-between px-4 pt-3.5 pb-2">
        <SectionLabel>workspaces</SectionLabel>
        <Button
          variant="ghost"
          size="icon"
          data-testid="add-workspace-open"
          title="add workspace"
          aria-label="add workspace"
          onClick={actions.openAddWorkspace}
          className="text-doom-faint hover:text-doom-hi"
        >
          <PlusIcon className="h-3 w-3" />
        </Button>
      </div>
      <div className="px-2.5">
        {rail.workspaces.map((workspace) => (
          <AdvancedWorkspaceGroup key={workspace.id} workspace={workspace} actions={actions} />
        ))}
      </div>
      {rail.workspaces.length === 0 ? (
        <div className="px-2.5 pt-2">
          <Button
            variant="outline"
            size="lg"
            data-testid="add-workspace-empty"
            onClick={actions.openAddWorkspace}
            className="w-full justify-start px-3 text-sm"
          >
            <PlusIcon className="h-3 w-3" />
            add workspace
          </Button>
        </div>
      ) : null}

      {rail.pluginContent}
      <div className="flex-1" />
      <div className="sticky bottom-0 mt-auto shrink-0 bg-doom-rail">
        {remote.status === 'off' ? null : (
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
                      remote.host === undefined ? '' : ` · ${remote.host}`
                    } · ${String(remote.deviceCount)} device${remote.deviceCount === 1 ? '' : 's'} paired`}
              </span>
            </output>
            <span className="flex items-center justify-end gap-1">
              <Button variant="ghost" size="sm" data-testid="remote-banner-open" onClick={actions.openRemoteAccess}>
                manage
              </Button>
              <Button variant="ghost" size="sm" data-testid="remote-banner-off" onClick={actions.turnRemoteAccessOff}>
                turn off
              </Button>
            </span>
          </div>
        )}
        <div className="flex items-center gap-2.5 border-t border-doom-border px-4 py-3">
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant="ghost"
                size="icon"
                data-testid="settings-open"
                aria-label="settings"
                onClick={actions.openSettings}
                className="text-doom-faint"
              >
                <GearIcon className="h-3 w-3" />
              </Button>
            </TooltipTrigger>
            <TooltipContent side="top">settings</TooltipContent>
          </Tooltip>
          <span className="text-2xs text-doom-faint max-sm:hidden">ctrl+k commands · ctrl+t new session</span>
        </div>
      </div>
    </div>
  );
}
