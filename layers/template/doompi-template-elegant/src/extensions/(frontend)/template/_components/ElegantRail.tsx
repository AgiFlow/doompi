import type { WebTemplateRail } from '@agimon-ai/doompi-core/web';
import { Button, Dot, GearIcon, PlusIcon, ShieldIcon } from '@agimon-ai/doompi-web-components';

import { ElegantWorkspaceGroup } from './ElegantWorkspaceGroup';

/** The drawer's session list: quiet labels, soft tiles, and a low-key footer. */
export function ElegantRail({ rail }: { rail: WebTemplateRail }) {
  const { remote, actions } = rail;
  const live = remote.status === 'on' || remote.status === 'starting';
  return (
    <div className="flex h-full flex-col gap-2 px-3 pb-3">
      <div className="flex items-center justify-between gap-2 pt-1">
        <Button
          variant="subtle"
          size="sm"
          data-testid="add-workspace-open"
          aria-label="add workspace"
          onClick={actions.openAddWorkspace}
          className="gap-1.5"
        >
          <PlusIcon className="h-3 w-3" />
          workspace
        </Button>
        <Button
          variant={live ? 'primary' : remote.status === 'failed' ? 'danger-outline' : 'ghost'}
          size="sm"
          data-testid="remote-access-open"
          aria-label={`remote access is ${remote.status}`}
          onClick={actions.openRemoteAccess}
          className="gap-1.5"
        >
          {live ? <Dot tone="yellow" pulse data-testid="remote-access-live" /> : <ShieldIcon className="h-3 w-3" />}
          remote
        </Button>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto">
        {rail.workspaces.map((workspace) => (
          <ElegantWorkspaceGroup key={workspace.id} workspace={workspace} actions={actions} />
        ))}
        {rail.workspaces.length === 0 ? (
          <Button
            variant="outline"
            size="lg"
            data-testid="add-workspace-empty"
            onClick={actions.openAddWorkspace}
            className="mt-4 w-full justify-start px-3 text-sm"
          >
            <PlusIcon className="h-3 w-3" />
            add your first workspace
          </Button>
        ) : null}
        {rail.pluginContent}
      </div>

      {remote.status === 'off' ? null : (
        <div
          data-testid="remote-banner"
          className={`flex items-center gap-2 rounded-lg px-3 py-2 text-xs ${
            remote.status === 'failed' ? 'bg-doom-tint-red text-doom-red' : 'bg-doom-tint-yellow text-doom-yellow'
          }`}
        >
          <Dot tone={remote.status === 'failed' ? 'red' : 'yellow'} />
          <span className="min-w-0 flex-1 truncate">
            {remote.status === 'failed'
              ? `remote access failed: ${remote.error ?? 'the tunnel stopped'}`
              : `remote ${remote.status === 'starting' ? 'starting' : 'on'}${
                  remote.host === undefined ? '' : ` · ${remote.host}`
                } · ${String(remote.deviceCount)} device${remote.deviceCount === 1 ? '' : 's'}`}
          </span>
          <Button variant="ghost" size="xs" data-testid="remote-banner-open" onClick={actions.openRemoteAccess}>
            manage
          </Button>
          <Button variant="ghost" size="xs" data-testid="remote-banner-off" onClick={actions.turnRemoteAccessOff}>
            off
          </Button>
        </div>
      )}
      <div className="flex items-center justify-between border-t border-doom-border-soft pt-2">
        <Button
          variant="ghost"
          size="sm"
          data-testid="settings-open"
          aria-label="settings"
          onClick={actions.openSettings}
          className="gap-1.5 text-doom-faint"
        >
          <GearIcon className="h-3 w-3" />
          settings
        </Button>
        <span className="text-2xs text-doom-faint max-sm:hidden">ctrl+t new session</span>
      </div>
    </div>
  );
}
