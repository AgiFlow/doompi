import {
  Button,
  Dialog,
  DialogBody,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  handleOptionListKey,
  Kbd,
  OptionList,
  optionListHint,
  Panel,
  ShieldIcon,
  Textarea,
} from '@agimon-ai/doompi-web-components';
import { useStore } from '@tanstack/react-store';
import { useEffect, useState } from 'react';
import { focusPrompt } from '../../lib/promptFocus.ts';
import { menuStore } from '../../stores/menuStore.ts';
import { answerDialogConfirm, answerDialogValue, cancelDialog, useActiveSession } from '../../stores/sessionStore.ts';
import { useToolPrompt } from '../../stores/useToolPrompt.ts';

/**
 * Renders the extension UI sub-protocol as a modal.
 *
 * The agent blocks on this answer, so the surface is modal and always offers a
 * way out: an unanswered request would strand the run. A select the user asked
 * for from the selection bar is that bar's popover instead (the claim is
 * settled when the frame arrives, see stores/menuStore.ts), and a request a
 * running tool owns is that tool's composer prompt, so this overlay leaves
 * both alone. A prompt that gives its request back is claimed by nobody, and
 * the modal opens after all rather than leaving the run with no answer.
 */
export function DialogOverlay() {
  const dialog = useActiveSession((state) => state.dialog);
  const claimed = useStore(menuStore, (state) => state.claimed);
  const prompt = useToolPrompt();
  const [value, setValue] = useState('');
  const [cursor, setCursor] = useState(0);

  useEffect(() => {
    setValue(dialog?.prefill ?? '');
    setCursor(0);
  }, [dialog?.id, dialog?.prefill]);

  if (!dialog) return null;
  if (dialog.method === 'select' && claimed !== null && claimed.dialogId === dialog.id) return null;
  if (prompt !== null && prompt.dialog.id === dialog.id) return null;

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
        // The dialog content is what the overlay focuses, so the option
        // keyboard is handled here rather than on the list itself.
        onKeyDown={(event) => {
          if (dialog.method !== 'select') return;
          handleOptionListKey(event, {
            options: dialog.options,
            cursor,
            onCursorChange: setCursor,
            onSelect: (option) => answerDialogValue(dialog.id, option),
          });
        }}
        // The agent pushed this dialog; nothing on the page opened it, so the
        // keyboard goes back to the composer rather than to the body.
        onCloseAutoFocus={(event) => {
          event.preventDefault();
          focusPrompt();
        }}
        className="rounded-[10px] border-doom-edge-magenta"
      >
        <DialogHeader className="h-[42px] border-doom-edge-magenta bg-doom-tint-magenta py-0">
          <DialogTitle data-testid="dialog-title" className="flex items-center gap-2 text-doom-magenta">
            <ShieldIcon className="h-[13px] w-[13px] shrink-0" />
            {dialog.title}
          </DialogTitle>
          <span className="text-[9px] text-doom-faint">extension · {dialog.method}</span>
        </DialogHeader>

        <DialogBody>
          {dialog.message && dialog.method === 'select' ? (
            <Panel data-testid="dialog-command" className="bg-doom-deep px-3 py-2.5">
              <div className="flex gap-2">
                <span className="text-[12px] text-doom-green">$</span>
                <pre
                  data-testid="dialog-message"
                  className="min-w-0 flex-1 whitespace-pre-wrap break-words text-[12px] leading-relaxed text-doom-hi"
                >
                  {dialog.message}
                </pre>
              </div>
            </Panel>
          ) : dialog.message ? (
            <p data-testid="dialog-message" className="text-[12px] leading-relaxed text-doom-text">
              {dialog.message}
            </p>
          ) : null}

          {dialog.method === 'select' ? (
            <OptionList
              options={dialog.options}
              cursor={cursor}
              onCursorChange={setCursor}
              testIdPrefix="dialog-option"
              onSelect={(option) => answerDialogValue(dialog.id, option)}
            />
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
        </DialogBody>

        <DialogFooter variant="bar" className="h-[34px]">
          <span data-testid="dialog-hints" className="flex items-center gap-1.5 text-[10px] text-doom-faint">
            {dialog.method === 'select' ? optionListHint(dialog.options.length) : 'enter confirm'} · <Kbd>esc</Kbd>{' '}
            cancels and tells the agent
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
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
