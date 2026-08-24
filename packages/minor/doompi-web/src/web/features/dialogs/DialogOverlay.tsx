import {
  Button,
  Dialog,
  DialogContent,
  DialogTitle,
  Kbd,
  ShieldIcon,
  Textarea,
} from '@agimon-ai/doompi-web-components';
import { useStore } from '@tanstack/react-store';
import { type KeyboardEvent as ReactKeyboardEvent, useEffect, useState } from 'react';
import { focusPrompt } from '../../lib/promptFocus.ts';
import { menuStore } from '../../stores/menuStore.ts';
import { answerDialogConfirm, answerDialogValue, cancelDialog, useActiveSession } from '../../stores/sessionStore.ts';

/**
 * Renders the extension UI sub-protocol as a modal.
 *
 * The agent blocks on this answer, so the surface is modal and always offers a
 * way out: an unanswered request would strand the run. A select the user asked
 * for from the selection bar is that bar's popover instead (the claim is
 * settled when the frame arrives, see stores/menuStore.ts), so this overlay
 * leaves it alone.
 */
export function DialogOverlay() {
  const dialog = useActiveSession((state) => state.dialog);
  const claimed = useStore(menuStore, (state) => state.claimed);
  const [value, setValue] = useState('');

  useEffect(() => {
    setValue(dialog?.prefill ?? '');
  }, [dialog?.id, dialog?.prefill]);

  if (!dialog) return null;
  if (dialog.method === 'select' && claimed !== null && claimed.dialogId === dialog.id) return null;

  // Keys are handled on the content, and consumed: a digit that answers the
  // agent must not also reach the rail's session shortcuts.
  const onKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>): void => {
    if (dialog.method !== 'select') return;
    const index = Number.parseInt(event.key, 10) - 1;
    const option = Number.isInteger(index) ? dialog.options[index] : undefined;
    if (option === undefined) return;
    event.preventDefault();
    event.stopPropagation();
    answerDialogValue(dialog.id, option);
  };

  return (
    <Dialog
      open
      onOpenChange={(next) => {
        if (!next) cancelDialog(dialog.id);
      }}
    >
      <DialogContent
        width="lg"
        data-testid="dialog"
        data-dialog-method={dialog.method}
        aria-describedby={undefined}
        onKeyDown={onKeyDown}
        // The agent pushed this dialog; nothing on the page opened it, so the
        // keyboard goes back to the composer rather than to the body.
        onCloseAutoFocus={(event) => {
          event.preventDefault();
          focusPrompt();
        }}
        className="rounded-[10px] border-doom-edge-magenta"
      >
        <div className="flex h-[42px] shrink-0 items-center justify-between border-b border-doom-edge-magenta bg-doom-tint-magenta px-4">
          <DialogTitle
            data-testid="dialog-title"
            className="flex items-center gap-2 text-[12px] font-bold tracking-wide text-doom-magenta"
          >
            <ShieldIcon className="h-[13px] w-[13px] shrink-0" />
            {dialog.title}
          </DialogTitle>
          <span className="text-[9px] text-doom-faint">extension · {dialog.method}</span>
        </div>

        <div className="flex min-h-0 flex-col gap-3 overflow-y-auto px-4 py-4">
          {dialog.message && dialog.method === 'select' ? (
            <div data-testid="dialog-command" className="rounded-md border border-doom-border bg-doom-deep px-3 py-2.5">
              <div className="flex gap-2">
                <span className="text-[12px] text-doom-green">$</span>
                <pre
                  data-testid="dialog-message"
                  className="min-w-0 flex-1 whitespace-pre-wrap break-words text-[12px] leading-relaxed text-doom-hi"
                >
                  {dialog.message}
                </pre>
              </div>
            </div>
          ) : dialog.message ? (
            <p data-testid="dialog-message" className="text-[12px] leading-relaxed text-doom-text">
              {dialog.message}
            </p>
          ) : null}

          {dialog.method === 'select' ? (
            <div className="flex flex-col gap-1.5">
              {dialog.options.map((option, index) => (
                <button
                  key={option}
                  type="button"
                  data-testid={`dialog-option-${index}`}
                  title={option}
                  onClick={() => answerDialogValue(dialog.id, option)}
                  className="flex min-h-[42px] items-center gap-3 rounded-md border border-doom-border-soft px-[11px] py-2 text-left text-[12px] text-doom-text transition-colors outline-none hover:border-doom-edge-blue hover:bg-doom-tint-blue focus-visible:border-doom-edge-blue focus-visible:bg-doom-tint-blue"
                >
                  <span className="flex h-[18px] w-[18px] shrink-0 items-center justify-center rounded-full bg-doom-deep text-[10px] font-bold text-doom-dim">
                    {index + 1}
                  </span>
                  <span className="min-w-0 flex-1 break-words">{option}</span>
                </button>
              ))}
            </div>
          ) : null}

          {dialog.method === 'input' || dialog.method === 'editor' ? (
            <Textarea
              data-testid="dialog-input"
              value={value}
              autoFocus
              rows={dialog.method === 'editor' ? 5 : 1}
              placeholder={dialog.placeholder}
              onChange={(event) => setValue(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter' && !event.shiftKey && dialog.method === 'input') {
                  event.preventDefault();
                  answerDialogValue(dialog.id, value);
                }
              }}
            />
          ) : null}
        </div>

        <div className="flex h-[34px] shrink-0 items-center justify-between border-t border-doom-border-soft bg-doom-deep px-4">
          <span data-testid="dialog-hints" className="flex items-center gap-1.5 text-[10px] text-doom-faint">
            <Kbd>1-9</Kbd> select · <Kbd>enter</Kbd> confirm · <Kbd>esc</Kbd> cancels and tells the agent
          </span>
          <div className="flex items-center gap-2">
            <Button variant="outline" size="sm" data-testid="dialog-cancel" onClick={() => cancelDialog(dialog.id)}>
              cancel
            </Button>
            {dialog.method === 'confirm' ? (
              <>
                <Button
                  variant="danger-outline"
                  size="sm"
                  data-testid="dialog-deny"
                  onClick={() => answerDialogConfirm(dialog.id, false)}
                >
                  no
                </Button>
                <Button
                  variant="success"
                  size="sm"
                  data-testid="dialog-confirm"
                  onClick={() => answerDialogConfirm(dialog.id, true)}
                >
                  yes
                </Button>
              </>
            ) : null}
            {dialog.method === 'input' || dialog.method === 'editor' ? (
              <Button
                variant="primary"
                size="sm"
                data-testid="dialog-submit"
                onClick={() => answerDialogValue(dialog.id, value)}
              >
                submit
              </Button>
            ) : null}
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
