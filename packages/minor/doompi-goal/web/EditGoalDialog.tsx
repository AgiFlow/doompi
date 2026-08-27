import {
  Button,
  Dialog,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  Input,
  Label,
  Textarea,
} from '@agimon-ai/doompi-web-components';
import { useState } from 'react';
import { editGoalCommand } from './goalCommands.ts';

/**
 * Correcting the objective the agent is working to.
 *
 * The form is the command it sends, so it shows that command rather than
 * describing it: `/goal edit` is what a reader would have typed in the
 * terminal, and seeing it spelled out is what makes the collapsed whitespace
 * and the omitted budget flag legible instead of surprising.
 *
 * The budget field starts empty on purpose. `/goal edit` leaves the budget
 * alone unless `--tokens` is present, so blank means keep, and the budget the
 * goal holds sits in the placeholder where it reads as the default rather than
 * as something already typed.
 */
export function EditGoalDialog({
  objective,
  budgetHint,
  open,
  onSubmit,
  onCancel,
}: {
  objective: string;
  /** The budget the goal holds, worded as the session words it; empty when it has none. */
  budgetHint: string;
  open: boolean;
  onSubmit: (command: string) => void;
  onCancel: () => void;
}) {
  const [draft, setDraft] = useState(objective);
  const [budget, setBudget] = useState('');
  const command = editGoalCommand(draft, budget);

  const close = (): void => {
    setDraft(objective);
    setBudget('');
    onCancel();
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) close();
      }}
    >
      <DialogContent width="sm" data-testid="goal-edit-dialog" aria-describedby={undefined}>
        <DialogHeader>
          <DialogTitle>edit goal</DialogTitle>
        </DialogHeader>
        <DialogBody>
          <DialogDescription>
            this replaces the objective the agent is working to. it takes effect on the next turn.
          </DialogDescription>
          <div className="flex flex-col gap-1">
            <Label htmlFor="goal-edit-objective">objective</Label>
            <Textarea
              id="goal-edit-objective"
              data-testid="goal-edit-objective"
              value={draft}
              rows={3}
              spellCheck={false}
              onChange={(event) => setDraft(event.target.value)}
              className="text-[11px]"
            />
          </div>
          <div className="flex flex-col gap-1">
            <Label htmlFor="goal-edit-budget">token budget</Label>
            <Input
              id="goal-edit-budget"
              data-testid="goal-edit-budget"
              value={budget}
              placeholder={
                budgetHint === '' ? 'none; leave blank to keep it that way' : `${budgetHint}; blank keeps it`
              }
              onChange={(event) => setBudget(event.target.value)}
              className="text-[11px]"
            />
          </div>
          <p data-testid="goal-edit-preview" className="truncate font-mono text-[9px] text-doom-faint">
            {command ?? 'nothing to send'}
          </p>
          <DialogFooter>
            <Button variant="outline" size="md" data-testid="goal-edit-cancel" onClick={close}>
              cancel
            </Button>
            <Button
              variant="primary"
              size="md"
              data-testid="goal-edit-save"
              disabled={command === undefined}
              onClick={() => {
                if (command === undefined) return;
                onSubmit(command);
                setBudget('');
              }}
            >
              save
            </Button>
          </DialogFooter>
        </DialogBody>
      </DialogContent>
    </Dialog>
  );
}
