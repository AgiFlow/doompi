import {
  Button,
  Dialog,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@agimon-ai/doompi-web-components';
import { useStore } from '@tanstack/react-store';
import { approveDevice, denyDevice, remoteAccessStore } from '../../stores/remoteAccessStore.ts';

/**
 * The second factor, and the reason a photographed QR is not enough.
 *
 * Only ever rendered on the host: the hub sends pairing frames to local pages
 * alone, so a paired phone cannot approve the next device and make its own
 * access permanent.
 */
export function PairingApprovalDialog() {
  const state = useStore(remoteAccessStore);
  const request = state.view?.pending?.[0];
  if (request === undefined) return null;

  return (
    <Dialog open>
      <DialogContent data-testid="pairing-approval" className="max-w-md">
        <DialogHeader>
          <DialogTitle>Pair this device?</DialogTitle>
          <DialogDescription>
            Something scanned your code. Approve it only if it is the device in your hand.
          </DialogDescription>
        </DialogHeader>
        <DialogBody className="flex flex-col gap-2">
          <p data-testid="pairing-approval-agent" className="break-words text-xs text-doom-hi">
            {request.userAgent}
          </p>
          {/* Labelled as reported rather than stated as fact: anything that can
              reach the tunnel listener can set this header to whatever it likes,
              so it is a clue for the human and never a security decision. */}
          <p className="text-[11px] text-doom-faint">address reported by the edge: {request.edgeIp}</p>
          <p className="text-[11px] text-doom-faint">
            Approving grants the same access you have here, including running shell commands.
          </p>
        </DialogBody>
        <DialogFooter>
          <Button variant="outline" data-testid="pairing-deny" onClick={() => void denyDevice(request.id)}>
            deny
          </Button>
          <Button variant="primary" data-testid="pairing-approve" onClick={() => void approveDevice(request.id)}>
            approve
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
