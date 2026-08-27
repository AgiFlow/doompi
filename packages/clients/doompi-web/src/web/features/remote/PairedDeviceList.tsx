import { Button, SectionLabel } from '@agimon-ai/doompi-web-components';
import { useStore } from '@tanstack/react-store';
import { remoteAccessStore, revokePairedDevice } from '../../stores/remoteAccessStore.ts';

/** Every device currently holding a session, with the one way to take it back. */
export function PairedDeviceList() {
  const state = useStore(remoteAccessStore);
  const devices = state.view?.devices ?? [];
  if (devices.length === 0) return null;

  return (
    <div className="flex w-full flex-col gap-1.5">
      <SectionLabel>paired devices</SectionLabel>
      {devices.map((device) => (
        <div
          key={device.id}
          data-testid={`remote-device-${device.id}`}
          className="flex items-center justify-between gap-3 rounded border border-doom-border px-2.5 py-1.5"
        >
          <span className="flex min-w-0 flex-col">
            <span className="truncate text-xs text-doom-hi">
              {device.label}
              {device.self ? ' \u00b7 this device' : ''}
            </span>
            <span className="truncate text-[10px] text-doom-faint">{device.userAgent}</span>
          </span>
          <Button
            variant="ghost"
            size="sm"
            data-testid={`remote-revoke-${device.id}`}
            onClick={() => void revokePairedDevice(device.id)}
          >
            revoke
          </Button>
        </div>
      ))}
    </div>
  );
}
