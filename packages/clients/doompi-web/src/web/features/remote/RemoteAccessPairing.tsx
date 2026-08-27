import { Button, SectionLabel, Spinner } from '@agimon-ai/doompi-web-components';
import { useStore } from '@tanstack/react-store';
import { QrCode } from '../../components/QrCode.tsx';
import { addPasskey, newPairingCode, remoteAccessStore } from '../../stores/remoteAccessStore.ts';
import { PairedDeviceList } from './PairedDeviceList.tsx';

/** The code to scan, plus the address for anyone whose camera will not cooperate. */
export function RemoteAccessPairing() {
  const state = useStore(remoteAccessStore);
  if (state.pairUrl === undefined) return <Spinner />;

  return (
    <div className="flex flex-col items-center gap-4">
      {/* A light plate under the code: scanners want dark modules on a bright
          field, which is the one thing a dark theme cannot supply. */}
      <div className="rounded-lg bg-doom-hi p-3 text-doom-deep">
        <QrCode value={state.pairUrl} size={196} label="Scan to pair this device" />
      </div>
      <div className="flex w-full flex-col gap-1">
        <SectionLabel>or open this address</SectionLabel>
        <code data-testid="remote-pair-url" className="break-all rounded bg-doom-deep p-2 text-[11px] text-doom-faint">
          {state.pairUrl}
        </code>
      </div>
      <Button variant="ghost" size="sm" data-testid="remote-new-code" onClick={() => void newPairingCode()}>
        show a new code
      </Button>

      {/* Enrolling a passkey turns every later visit into one Face ID instead
          of another scan, and it is what puts a second factor in front of the
          two actions that escalate past driving the agent. */}
      {state.passkeys?.supported === true ? (
        <div className="flex w-full flex-col gap-1.5 border-t border-doom-border pt-3">
          <SectionLabel>passkeys</SectionLabel>
          <p className="text-[11px] text-doom-faint">
            {state.passkeys.count === 0
              ? 'Add one on the device you just paired and it will not need the code again.'
              : `${String(state.passkeys.count)} registered. A paired device signs in with a gesture instead of a code.`}
          </p>
          <Button variant="outline" size="sm" data-testid="remote-add-passkey" onClick={() => void addPasskey()}>
            add a passkey for this device
          </Button>
        </div>
      ) : state.passkeys?.reason === undefined ? null : (
        <p data-testid="remote-passkey-unavailable" className="w-full text-[11px] text-doom-faint">
          {state.passkeys.reason}
        </p>
      )}

      <PairedDeviceList />
    </div>
  );
}
