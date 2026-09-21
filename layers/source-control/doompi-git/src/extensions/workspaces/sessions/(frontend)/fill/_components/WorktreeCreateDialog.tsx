import type { WebPluginSlotProps } from '@agimon-ai/doompi-core/web';
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DropdownMenuItem,
} from '@agimon-ai/doompi-web-components';
import { useStore } from '@tanstack/react-store';
import { useEffect } from 'react';

import { WorktreesPanel } from '../../_components/WorktreesPanel';
import { worktreeCreateDialog, worktreesChannel } from '../../_lib/worktreesActivityStore';

export function WorktreeSessionMenu({ sessionId, sessionReservationId }: WebPluginSlotProps) {
  return (
    <DropdownMenuItem
      disabled={sessionId === null}
      data-testid={`session-worktree-${sessionReservationId ?? sessionId}`}
      onSelect={() => {
        if (sessionId !== null)
          worktreeCreateDialog.update(() => ({
            sessionId,
            ...(sessionReservationId === undefined ? {} : { reservationId: sessionReservationId }),
          }));
      }}
    >
      create worktree session…
    </DropdownMenuItem>
  );
}

export function WorktreeCreateOverlay(props: WebPluginSlotProps) {
  const target = useStore(worktreeCreateDialog.store);
  const { holdSessionChannels } = props;
  useEffect(() => {
    if (target === null) return;
    return holdSessionChannels?.(target.sessionId, (frame) => {
      if (frame.type !== worktreesChannel.channel) return;
      const payload = worktreesChannel.parse(frame.payload);
      if (payload !== null) worktreesChannel.apply(target.sessionId, payload);
    });
  }, [target, holdSessionChannels]);
  if (target === null) return null;
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) worktreeCreateDialog.update(() => null);
      }}
    >
      <DialogContent width="lg" data-testid="session-worktree-dialog">
        <DialogHeader>
          <DialogTitle>create worktree session</DialogTitle>
        </DialogHeader>
        <DialogBody>
          <DialogDescription>
            Creates a separate checkout and a new session. Existing sessions stay in their current directories.
          </DialogDescription>
          <WorktreesPanel
            {...props}
            key={`${target.sessionId}:${target.reservationId ?? ''}`}
            sessionId={target.sessionId}
            sessionReservationId={target.reservationId}
          />
        </DialogBody>
      </DialogContent>
    </Dialog>
  );
}
