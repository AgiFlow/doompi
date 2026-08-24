import { type KeyboardEvent as ReactKeyboardEvent, useEffect, useRef, useState } from 'react';
import { clearPendingMenu, type MenuKind, pendingMenuFor } from '../../stores/menuStore.ts';
import { answerDialogConfirm, answerDialogValue, cancelDialog, useActiveSession } from '../../stores/sessionStore.ts';

// The known axes keep their mockup styling; a plugin-declared axis the host
// has no entry for falls back to its uppercased name in the neutral accent.
const MENU_TITLE: Readonly<Record<string, string>> = {
  mode: 'MAJOR MODE',
  profile: 'PROFILE',
  domains: 'DOMAINS',
};

const DEFAULT_ACCENT = { border: 'border-doom-border', title: 'text-doom-hi' };

const MENU_ACCENT: Readonly<Record<string, { border: string; title: string }>> = {
  mode: { border: 'border-[#2F4A68]', title: 'text-doom-blue' },
  profile: { border: 'border-[#35452E]', title: 'text-doom-green' },
  domains: { border: 'border-[#3B3558]', title: 'text-doom-violet' },
};

function ShieldIcon() {
  return (
    <svg viewBox="0 0 13 13" className="h-[13px] w-[13px] shrink-0" aria-hidden>
      <path
        d="M6.5 1 L11 2.8 V6 C11 9 9 11 6.5 12 C4 11 2 9 2 6 V2.8 Z"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.1"
        strokeLinejoin="round"
      />
    </svg>
  );
}

/**
 * Renders the extension UI sub-protocol.
 *
 * The agent blocks on this answer, so the surface is modal and always offers a
 * way out: an unanswered request would strand the run. A select the user asked
 * for from the selection bar renders as that bar's popover menu instead of the
 * centered card, which is the same dialog wearing the mockup's menu styling.
 */
export function DialogOverlay() {
  const dialog = useActiveSession((state) => state.dialog);
  const [value, setValue] = useState('');
  const [menu, setMenu] = useState<MenuKind | null>(null);
  const surface = useRef<HTMLDivElement>(null);

  useEffect(() => {
    setValue(dialog?.prefill ?? '');
  }, [dialog?.id, dialog?.prefill]);

  // The anchor is read once per dialog: whichever selection button was pressed
  // most recently claims this dialog as its menu, then the claim is spent.
  useEffect(() => {
    if (dialog && dialog.method === 'select') {
      setMenu(pendingMenuFor(Date.now()));
      clearPendingMenu();
    }
    if (!dialog) setMenu(null);
  }, [dialog?.id, dialog?.method, dialog !== null]);

  // Keys are handled on the overlay itself rather than on window: the element
  // exists the moment the dialog renders, so a keystroke cannot arrive before
  // the handler, and nothing can answer the agent twice by double-handling.
  useEffect(() => {
    if (dialog) surface.current?.focus();
  }, [dialog?.id]);

  if (!dialog) return null;

  const onKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>): void => {
    if (event.key === 'Escape') {
      cancelDialog(dialog.id);
      return;
    }
    if (dialog.method !== 'select') return;
    const index = Number.parseInt(event.key, 10) - 1;
    const option = Number.isInteger(index) ? dialog.options[index] : undefined;
    if (option !== undefined) answerDialogValue(dialog.id, option);
  };

  if (menu !== null && dialog.method === 'select') {
    const accent = MENU_ACCENT[menu] ?? DEFAULT_ACCENT;
    return (
      <div ref={surface} tabIndex={-1} onKeyDown={onKeyDown} className="absolute inset-0 z-20 outline-none">
        <div
          data-testid="dialog"
          data-dialog-method={dialog.method}
          data-dialog-menu={menu}
          className={`absolute bottom-[104px] left-[314px] w-[420px] overflow-hidden rounded-lg border bg-doom-panel shadow-2xl ${accent.border}`}
        >
          <div className="flex h-[34px] items-center justify-between border-b border-doom-border-soft bg-doom-deep px-3">
            <span data-testid="dialog-title" className={`text-[10px] font-bold tracking-wide ${accent.title}`}>
              {MENU_TITLE[menu] ?? menu.toUpperCase()}
            </span>
            <span className="text-[9px] text-doom-faint">{dialog.title}</span>
          </div>
          <div className="flex flex-col gap-0.5 p-1.5">
            {dialog.options.map((option, index) => (
              <button
                key={option}
                type="button"
                data-testid={`dialog-option-${index}`}
                onClick={() => answerDialogValue(dialog.id, option)}
                className="flex items-center gap-2.5 rounded-[5px] px-2 py-[7px] text-left hover:bg-[#21313F]"
              >
                <span className="flex h-[15px] w-[15px] shrink-0 items-center justify-center rounded-full border border-doom-border text-[8px] font-bold text-doom-faint">
                  {index + 1}
                </span>
                <span className="min-w-0 flex-1 truncate text-[12px] text-doom-text">{option}</span>
              </button>
            ))}
          </div>
          <div className="flex h-[30px] items-center justify-between border-t border-doom-border-soft bg-doom-deep px-3">
            <span data-testid="dialog-hints" className="text-[9px] text-doom-faint">
              1-9 select · esc closes
            </span>
            <button
              type="button"
              data-testid="dialog-cancel"
              onClick={() => cancelDialog(dialog.id)}
              className="text-[9px] text-doom-faint hover:text-doom-hi"
            >
              cancel
            </button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div
      ref={surface}
      tabIndex={-1}
      onKeyDown={onKeyDown}
      className="absolute inset-0 z-20 flex items-center justify-center bg-[#1B2229]/70 outline-none"
    >
      <div
        data-testid="dialog"
        data-dialog-method={dialog.method}
        className="w-[620px] overflow-hidden rounded-[10px] border border-[#4A3358] bg-doom-panel shadow-2xl"
      >
        <div className="flex h-[42px] items-center justify-between border-b border-[#4A3358] bg-[#2E2136] px-4">
          <span
            data-testid="dialog-title"
            className="flex items-center gap-2 text-[12px] font-bold tracking-wide text-doom-magenta"
          >
            <ShieldIcon />
            {dialog.title}
          </span>
          <span className="text-[9px] text-doom-faint">extension · {dialog.method}</span>
        </div>

        <div className="flex flex-col gap-3 px-4 py-4">
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
                  onClick={() => answerDialogValue(dialog.id, option)}
                  className="flex h-[42px] items-center gap-3 rounded-md border border-doom-border-soft px-[11px] text-left text-[12px] text-doom-text hover:border-[#2F4A68] hover:bg-[#21313F]"
                >
                  <span className="flex h-[18px] w-[18px] shrink-0 items-center justify-center rounded-full bg-doom-deep text-[10px] font-bold text-doom-dim">
                    {index + 1}
                  </span>
                  {option}
                </button>
              ))}
            </div>
          ) : null}

          {dialog.method === 'input' || dialog.method === 'editor' ? (
            <textarea
              data-testid="dialog-input"
              value={value}
              rows={dialog.method === 'editor' ? 5 : 1}
              placeholder={dialog.placeholder}
              onChange={(event) => setValue(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter' && !event.shiftKey && dialog.method === 'input') {
                  event.preventDefault();
                  answerDialogValue(dialog.id, value);
                }
              }}
              className="resize-none rounded border border-doom-border bg-doom-deep px-3 py-2 text-[12px] text-doom-hi outline-none placeholder:text-doom-faint"
            />
          ) : null}
        </div>

        <div className="flex h-[34px] items-center justify-between border-t border-doom-border-soft bg-doom-deep px-4">
          <span data-testid="dialog-hints" className="text-[10px] text-doom-faint">
            1-9 select · enter confirm · esc cancels and tells the agent
          </span>
          <div className="flex items-center gap-2">
            <button
              type="button"
              data-testid="dialog-cancel"
              onClick={() => cancelDialog(dialog.id)}
              className="rounded border border-doom-border px-3 py-0.5 text-[11px] text-doom-dim hover:text-doom-hi"
            >
              cancel
            </button>
            {dialog.method === 'confirm' ? (
              <>
                <button
                  type="button"
                  data-testid="dialog-deny"
                  onClick={() => answerDialogConfirm(dialog.id, false)}
                  className="rounded border border-[#6B3A3A] bg-[#332428] px-3 py-0.5 text-[11px] font-bold text-doom-red"
                >
                  no
                </button>
                <button
                  type="button"
                  data-testid="dialog-confirm"
                  onClick={() => answerDialogConfirm(dialog.id, true)}
                  className="rounded bg-doom-green px-3 py-0.5 text-[11px] font-bold text-doom-rail"
                >
                  yes
                </button>
              </>
            ) : null}
            {dialog.method === 'input' || dialog.method === 'editor' ? (
              <button
                type="button"
                data-testid="dialog-submit"
                onClick={() => answerDialogValue(dialog.id, value)}
                className="rounded bg-doom-blue px-3 py-0.5 text-[11px] font-bold text-doom-rail"
              >
                submit
              </button>
            ) : null}
          </div>
        </div>
      </div>
    </div>
  );
}
