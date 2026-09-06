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
 * The confirmation that stands between the delete button and the unlink.
 *
 * Deleting is the one action here with nothing behind it: a manual save can be
 * undone from the file's own history, and a comment can be removed before it
 * is sent, but this session's snapshots go when the session does, so a file
 * removed by mistake is not coming back from anything the cockpit holds.
 */
export interface DeleteFileDialogProps {
  relPath: string;
  open: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}

export function DeleteFileDialog({ relPath, open, onConfirm, onCancel }: DeleteFileDialogProps) {
  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) onCancel();
      }}
    >
      <DialogContent width="sm" data-testid="files-delete-dialog" aria-describedby={undefined}>
        <DialogHeader>
          <DialogTitle>delete file</DialogTitle>
        </DialogHeader>
        <DialogBody>
          <DialogDescription>
            this removes <span className="font-bold text-doom-hi">{relPath}</span> from disk. the session keeps its
            record of the change, but the file itself is gone.
          </DialogDescription>
          <DialogFooter>
            <Button variant="outline" size="md" data-testid="files-delete-cancel" autoFocus onClick={onCancel}>
              cancel
            </Button>
            <Button variant="danger" size="md" data-testid="files-delete-confirm" onClick={onConfirm}>
              delete
            </Button>
          </DialogFooter>
        </DialogBody>
      </DialogContent>
    </Dialog>
  );
}
