import { Spinner } from '@agimon-ai/doompi-web-components';
import { useStore } from '@tanstack/react-store';
import { useEffect } from 'react';
import { refreshRemoteState, remoteAccessStore } from '../../stores/remoteAccessStore.ts';
import { TunnelSettings } from './TunnelSettings.tsx';

/** Persistent tunnel configuration, separate from the dialog that starts and pairs a remote session. */
export function RemoteControlSettings() {
  const state = useStore(remoteAccessStore);

  useEffect(() => {
    void refreshRemoteState();
  }, []);

  return (
    <div data-testid="remote-control-settings" className="flex max-w-[780px] flex-col gap-5">
      <div className="flex flex-col gap-1">
        <h2 className="text-[13px] font-bold text-doom-hi">remote control</h2>
        <p className="text-[11px] leading-relaxed text-doom-dim">
          configure how remote devices reach this cockpit. a named tunnel is saved on this machine and reused whenever
          remote access starts.
        </p>
      </div>

      {state.view === undefined ? (
        <p className="flex items-center gap-2 text-[11px] text-doom-faint">
          <Spinner label="reading remote control settings" />
          reading remote control settings…
        </p>
      ) : (
        <TunnelSettings tunnel={state.view.settings.tunnel} />
      )}

      <p className="text-[11px] leading-relaxed text-doom-faint">
        install <code>cloudflared</code> on this machine before turning remote access on. the remote access dialog
        remains the place to start the tunnel, pair devices, and turn access off.
      </p>
    </div>
  );
}
