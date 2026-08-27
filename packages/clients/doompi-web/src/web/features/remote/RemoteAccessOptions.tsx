import { Input, Spinner, Switch } from '@agimon-ai/doompi-web-components';
import { useStore } from '@tanstack/react-store';
import { remoteAccessStore, updateRemoteSettings } from '../../stores/remoteAccessStore.ts';
import { PairedDeviceList } from './PairedDeviceList.tsx';
import { SandboxWorkspaces } from './SandboxWorkspaces.tsx';

const MAX_MINUTES = 1440;
const MAX_HOURS = 720;

/**
 * The bounds on remote access, asked before it is switched on.
 *
 * These sit in front of the decision rather than behind a gear elsewhere,
 * because they are the difference between a tunnel that closes itself and one
 * that is still open next week.
 */
export function RemoteAccessOptions() {
  const state = useStore(remoteAccessStore);
  const settings = state.view?.settings;
  if (settings === undefined) return <Spinner />;

  return (
    <div className="flex flex-col gap-4">
      <label className="flex items-start justify-between gap-4">
        <span className="flex flex-col gap-0.5">
          <span className="text-xs text-doom-hi">close the tunnel automatically</span>
          <span className="text-[11px] text-doom-faint">
            So a tunnel you forgot about does not stay open for weeks.
          </span>
        </span>
        <Switch
          data-testid="remote-autoclose-switch"
          checked={settings.autoCloseEnabled}
          onCheckedChange={(checked) => void updateRemoteSettings({ autoCloseEnabled: checked })}
        />
      </label>
      {settings.autoCloseEnabled ? (
        <label className="flex items-center justify-between gap-4 pl-4">
          <span className="text-[11px] text-doom-faint">after this many minutes</span>
          <Input
            data-testid="remote-autoclose-minutes"
            type="number"
            min={1}
            max={MAX_MINUTES}
            className="w-24"
            value={settings.autoCloseMinutes}
            onChange={(event) => void updateRemoteSettings({ autoCloseMinutes: Number(event.target.value) })}
          />
        </label>
      ) : null}

      <label className="flex items-start justify-between gap-4">
        <span className="flex flex-col gap-0.5">
          <span className="text-xs text-doom-hi">expire paired sessions</span>
          <span className="text-[11px] text-doom-faint">
            A device that goes quiet, or has simply been paired a long time, has to pair again.
          </span>
        </span>
        <Switch
          data-testid="remote-expiry-switch"
          checked={settings.sessionExpiryEnabled}
          onCheckedChange={(checked) => void updateRemoteSettings({ sessionExpiryEnabled: checked })}
        />
      </label>
      {settings.sessionExpiryEnabled ? (
        <div className="flex items-center justify-between gap-4 pl-4">
          <label className="flex items-center gap-2 text-[11px] text-doom-faint">
            idle minutes
            <Input
              data-testid="remote-idle-minutes"
              type="number"
              min={1}
              max={MAX_MINUTES}
              className="w-20"
              value={settings.idleMinutes}
              onChange={(event) => void updateRemoteSettings({ idleMinutes: Number(event.target.value) })}
            />
          </label>
          <label className="flex items-center gap-2 text-[11px] text-doom-faint">
            total hours
            <Input
              data-testid="remote-absolute-hours"
              type="number"
              min={1}
              max={MAX_HOURS}
              className="w-20"
              value={settings.absoluteHours}
              onChange={(event) => void updateRemoteSettings({ absoluteHours: Number(event.target.value) })}
            />
          </label>
        </div>
      ) : null}

      <label className="flex items-start justify-between gap-4">
        <span className="flex flex-col gap-0.5">
          <span className="text-xs text-doom-hi">run the cockpit in a container</span>
          <span className="text-[11px] text-doom-faint">
            The agent gets a shell either way. This decides whether that shell can see the rest of this machine.
          </span>
        </span>
        <Switch
          data-testid="remote-sandbox-switch"
          checked={settings.sandbox.enabled}
          onCheckedChange={(checked) =>
            void updateRemoteSettings({ sandbox: { ...settings.sandbox, enabled: checked } })
          }
        />
      </label>
      {settings.sandbox.enabled ? <SandboxWorkspaces workspaces={settings.sandbox.workspaces} /> : null}
      {settings.sandbox.enabled ? (
        <p className="text-[11px] text-doom-faint">
          Turning remote access on moves this cockpit into the container and reopens it on the same address. Running
          sessions inside the mounted workspaces move with it; the first start builds the image, which takes a while.
        </p>
      ) : null}

      <p className="text-[11px] text-doom-faint">
        Switching remote access off always revokes every paired device. Requires <code>cloudflared</code> on PATH.
      </p>

      <PairedDeviceList />
    </div>
  );
}
