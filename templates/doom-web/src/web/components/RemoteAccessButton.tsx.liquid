import { Button, Dot, ShieldIcon } from '@agimon-ai/doompi-web-components';
import type { RemoteAccessStatus } from '../../types/remoteAccess.ts';

export interface RemoteAccessButtonProps {
  status: RemoteAccessStatus;
  /** How many devices hold a session, so the label can say whether anyone is on. */
  deviceCount: number;
  onOpen: () => void;
}

/**
 * The header's remote-access control.
 *
 * Labelled rather than an icon alone. A bare shield is a guess, and the one
 * control that can put a shell on this machine within reach of the internet is
 * the last place to make somebody guess. While the tunnel is up it also stops
 * being quiet: a live dot and a warning tone, so a forgotten tunnel is visible
 * from across the room rather than hidden in the chrome.
 *
 * Presentational on purpose. It takes state and one callback, so the sessions
 * rail can place it without importing the remote feature, which
 * no-cross-feature-import forbids.
 */
export function RemoteAccessButton({ status, deviceCount, onOpen }: RemoteAccessButtonProps) {
  const live = status === 'on' || status === 'starting';
  const failed = status === 'failed';
  const detail =
    status === 'on'
      ? `remote access on, ${String(deviceCount)} device${deviceCount === 1 ? '' : 's'} paired`
      : undefined;

  return (
    <Button
      variant={live ? 'primary' : failed ? 'danger-outline' : 'outline'}
      size="sm"
      data-testid="remote-access-open"
      title={detail ?? 'remote access'}
      aria-label={detail ?? `remote access is ${status}`}
      onClick={onOpen}
      className="gap-1.5"
    >
      {live ? <Dot tone="yellow" pulse data-testid="remote-access-live" /> : <ShieldIcon className="h-3 w-3" />}
      remote access
    </Button>
  );
}
