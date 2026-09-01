import { Button, Dot } from '@agimon-ai/doompi-web-components';
import { useStore } from '@tanstack/react-store';
import { openRemoteDialog, remoteAccessStore, turnRemoteAccessOff } from '../../stores/remoteAccessStore.ts';

/**
 * An unmissable strip while the tunnel is up.
 *
 * Deliberately not dismissible. Somebody who forgot they opened this should be
 * reminded every time they look at the cockpit, and the way to make it go away
 * should be closing the tunnel rather than closing the notice.
 */
export function RemoteBanner() {
  const state = useStore(remoteAccessStore);
  const view = state.view;
  if (view === undefined || view.status === 'off') return null;

  const failed = view.status === 'failed';
  const host = view.publicUrl === undefined ? undefined : new URL(view.publicUrl).host;
  const count = view.devices.length;

  return (
    <div
      data-testid="remote-banner"
      className={`flex items-center justify-between gap-3 px-4 py-1.5 text-[11px] ${
        failed ? 'bg-doom-tint-red text-doom-red' : 'bg-doom-tint-yellow text-doom-yellow'
      }`}
    >
      <output className="flex min-w-0 items-center gap-2">
        <Dot tone={failed ? 'red' : 'yellow'} />
        {failed ? (
          <span className="truncate">remote access failed: {view.error ?? 'the tunnel stopped'}</span>
        ) : (
          <span className="truncate">
            remote access is {view.status === 'starting' ? 'starting' : 'on'}
            {host === undefined ? '' : ` \u00b7 ${host}`}
            {` \u00b7 ${String(count)} device${count === 1 ? '' : 's'} paired`}
          </span>
        )}
      </output>
      <span className="flex shrink-0 items-center gap-1">
        <Button variant="ghost" size="sm" data-testid="remote-banner-open" onClick={openRemoteDialog}>
          manage
        </Button>
        <Button variant="ghost" size="sm" data-testid="remote-banner-off" onClick={() => void turnRemoteAccessOff()}>
          turn off
        </Button>
      </span>
    </div>
  );
}
