import {
  Button,
  Dialog,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  Spinner,
} from '@agimon-ai/doompi-web-components';
import { useStore } from '@tanstack/react-store';
import {
  closeRemoteDialog,
  newPairingCode,
  remoteAccessStore,
  showRemoteOptions,
  turnRemoteAccessOff,
  turnRemoteAccessOn,
} from '../../stores/remoteAccessStore.ts';
import { HandoverProgress } from './HandoverProgress.tsx';
import { RemoteAccessOptions } from './RemoteAccessOptions.tsx';
import { RemoteAccessPairing } from './RemoteAccessPairing.tsx';

/**
 * Two panels rather than one.
 *
 * Turning this on puts a shell on this machine within reach of the internet, so
 * the settings that bound it come first and the code to scan comes second, once
 * those are answered.
 */
export function RemoteAccessDialog() {
  const state = useStore(remoteAccessStore);
  const view = state.view;
  const pairing = state.step === 'pairing';
  const moving = state.step === 'handover';
  const starting = state.busy || view?.status === 'starting';

  return (
    <Dialog open={state.step !== 'closed'} onOpenChange={(next) => (next ? undefined : closeRemoteDialog())}>
      <DialogContent width="lg" data-testid="remote-access-dialog" aria-describedby={undefined}>
        <DialogHeader>
          <DialogTitle>{pairing ? 'Pair a device' : 'Remote access'}</DialogTitle>
          <DialogDescription>
            {pairing
              ? 'Scan this with the device you want to use. You will be asked to approve it here.'
              : 'Reach this cockpit from your phone over a public tunnel.'}
          </DialogDescription>
        </DialogHeader>

        <DialogBody className="flex flex-col gap-5">
          {/* Said before the switch, not after: a paired device can do
              everything the person at this keyboard can do. */}
          <p className="text-xs leading-relaxed text-doom-faint">
            A paired device can prompt the agent, approve its tool calls, and run shell commands as you. Pair only
            devices you hold, and only when you mean to.
          </p>

          {moving ? <HandoverProgress /> : null}
          {pairing ? <RemoteAccessPairing /> : null}
          {pairing || moving ? null : <RemoteAccessOptions />}

          {state.error === undefined ? null : (
            <p data-testid="remote-access-error" className="text-xs text-doom-red">
              {state.error}
            </p>
          )}
        </DialogBody>

        {/* Nothing to offer during a handover: every control here would call a
            server that is in the middle of being replaced. */}
        <DialogFooter className={moving ? 'hidden' : undefined}>
          {view?.status === 'on' ? (
            <>
              <Button
                variant="danger-outline"
                data-testid="remote-access-off"
                disabled={state.busy}
                onClick={() => void turnRemoteAccessOff()}
              >
                turn off
              </Button>
              {pairing ? (
                <Button variant="ghost" data-testid="remote-access-back" onClick={showRemoteOptions}>
                  options
                </Button>
              ) : (
                <Button
                  variant="primary"
                  data-testid="remote-access-pair"
                  disabled={state.busy}
                  onClick={() => void newPairingCode()}
                >
                  pair a device
                </Button>
              )}
            </>
          ) : (
            <Button
              variant="primary"
              data-testid="remote-access-on"
              disabled={starting}
              onClick={() => void turnRemoteAccessOn()}
            >
              {starting ? <Spinner /> : null}
              turn on and show the code
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
