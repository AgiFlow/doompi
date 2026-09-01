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

/**
 * The confirmation between the "remove" menu item and `/goal clear`.
 *
 * Removing a goal is not just clearing a row: the session archives it to this
 * repository's goal history and aborts the turn in flight. Both are worth
 * saying, because one is recoverable and the other interrupts work the reader
 * may be watching.
 */
export function RemoveGoalDialog({
  objective,
  open,
  onConfirm,
  onCancel,
}: {
  objective: string;
  open: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) onCancel();
      }}
    >
      <DialogContent width="sm" data-testid="goal-remove-dialog" aria-describedby={undefined}>
        <DialogHeader>
          <DialogTitle>remove goal</DialogTitle>
        </DialogHeader>
        <DialogBody>
          <DialogDescription>
            this ends <span className="font-bold text-doom-hi">{objective}</span> and stops the current turn. it is
            archived to this repository's goal history, where it can be restarted.
          </DialogDescription>
          <DialogFooter>
            <Button variant="outline" size="md" data-testid="goal-remove-cancel" autoFocus onClick={onCancel}>
              cancel
            </Button>
            <Button variant="danger" size="md" data-testid="goal-remove-confirm" onClick={onConfirm}>
              remove
            </Button>
          </DialogFooter>
        </DialogBody>
      </DialogContent>
    </Dialog>
  );
}
