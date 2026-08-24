import { useEffect, useRef, useState } from 'react';
import { minorModes, type MinorMode } from '../../lib/composition.ts';
import { parseSelection } from '../../lib/statusLine.ts';
import { setPendingMenu } from '../../stores/menuStore.ts';
import { runCommand, useActiveSession } from '../../stores/sessionStore.ts';

function Caret({ className }: { className: string }) {
  return (
    <svg viewBox="0 0 10 10" className={`h-[10px] w-[10px] shrink-0 ${className}`} aria-hidden>
      <path d="M2 3.5 L5 6.5 L8 3.5" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
    </svg>
  );
}

const AVAILABILITY_TONE: Readonly<Record<MinorMode['availability'], string>> = {
  on: 'text-doom-hi',
  off: 'text-doom-dim',
  unavailable: 'text-doom-faint/60',
};

/**
 * The mockup's minor-modes popup is entirely local: the list is derived from
 * the statuses the session already published, so no agent round-trip is
 * needed to show it.
 */
function MinorModesPopup({ modes, onClose }: { modes: MinorMode[]; onClose: () => void }) {
  const surface = useRef<HTMLDivElement>(null);

  useEffect(() => {
    surface.current?.focus();
  }, []);

  const on = modes.filter((mode) => mode.availability === 'on').length;

  return (
    <div
      ref={surface}
      tabIndex={-1}
      data-testid="minor-popup"
      onKeyDown={(event) => {
        if (event.key === 'Escape') onClose();
      }}
      onBlur={(event) => {
        if (!surface.current?.contains(event.relatedTarget as Node | null)) onClose();
      }}
      className="absolute bottom-[42px] left-[170px] z-30 w-[430px] overflow-hidden rounded-lg border border-[#4A3358] bg-doom-panel shadow-2xl outline-none"
    >
      <div className="flex h-[34px] items-center justify-between border-b border-doom-border-soft bg-doom-deep px-3">
        <span className="text-[10px] font-bold tracking-wide text-doom-magenta">MINOR MODES</span>
        <span className="text-[9px] text-doom-faint">{on} on</span>
      </div>
      <div className="flex flex-col gap-0.5 p-1.5">
        {modes.map((mode) => (
          <div
            key={mode.name}
            data-testid={`minor-${mode.name}`}
            data-availability={mode.availability}
            className={`flex items-center gap-2.5 rounded-[5px] px-2 py-1.5 ${mode.availability === 'on' ? 'bg-[#2E2136]' : ''}`}
          >
            <span
              className={`w-8 shrink-0 rounded px-1 py-0.5 text-center text-[8px] font-bold ${
                mode.availability === 'on' ? 'bg-doom-magenta/25 text-doom-magenta' : 'bg-doom-deep text-doom-faint'
              }`}
            >
              {mode.keys}
            </span>
            <span className={`flex-1 truncate text-[12px] ${AVAILABILITY_TONE[mode.availability]}`}>{mode.name}</span>
            {mode.detail ? (
              <span data-testid={`minor-detail-${mode.name}`} className="truncate text-[9px] text-doom-magenta">
                {mode.detail}
              </span>
            ) : null}
            {mode.availability === 'unavailable' ? (
              <span className="text-[8px] text-doom-faint/60">n/a</span>
            ) : (
              <span
                className={`h-1.5 w-1.5 shrink-0 rounded-full ${mode.availability === 'on' ? 'bg-doom-magenta' : 'bg-doom-faint/40'}`}
              />
            )}
          </div>
        ))}
      </div>
      <div className="flex h-[30px] items-center border-t border-doom-border-soft bg-doom-deep px-3">
        <span className="text-[9px] text-doom-faint">published by the session · esc closes</span>
      </div>
    </div>
  );
}

/**
 * The mockup's bottom bar: the DoomPi selection axes as buttons, the model,
 * and the context gauge. Buttons route through the same slash commands the
 * TUI uses; the agent's select dialog then opens as this bar's popover menu.
 */
export function SelectionBar() {
  const raw = useActiveSession((state) => state.statuses['doom-major-mode'] ?? '');
  const statuses = useActiveSession((state) => state.statuses);
  const widgets = useActiveSession((state) => state.widgets);
  const agent = useActiveSession((state) => state.agent);
  const stats = useActiveSession((state) => state.stats);
  const [minorOpen, setMinorOpen] = useState(false);

  const selection = parseSelection(raw);
  const modes = minorModes(statuses, widgets);
  const activeMinors = modes.filter((mode) => mode.availability === 'on');

  const ask = (kind: 'mode' | 'profile' | 'domains'): void => {
    setPendingMenu(kind);
    runCommand(kind === 'mode' ? 'mode' : kind);
  };

  return (
    <footer
      data-testid="selection-bar"
      data-pending={selection.pending}
      className="relative flex h-[34px] shrink-0 items-center gap-2 border-t border-doom-border bg-doom-rail px-3.5"
    >
      <button
        type="button"
        data-testid="axis-mode"
        onClick={() => ask('mode')}
        className={`flex h-[21px] items-center gap-1.5 rounded-[3px] px-2 ${
          selection.pending ? 'bg-doom-yellow' : 'bg-doom-blue'
        } text-doom-rail`}
      >
        <span data-testid="selection-mode" className="text-[10px] font-bold tracking-[0.08em]">
          {(selection.majorMode || 'mode').toUpperCase()}
        </span>
        <Caret className="text-doom-rail" />
      </button>

      <button
        type="button"
        data-testid="axis-profile"
        onClick={() => ask('profile')}
        className="flex h-[21px] items-center gap-1.5 rounded-[3px] border border-doom-border px-2"
      >
        <span
          data-testid="selection-profile"
          className={`text-[10px] font-bold ${selection.profile ? 'text-doom-green' : 'text-doom-faint'}`}
        >
          {selection.profile ? `*${selection.profile}*` : 'no profile'}
        </span>
        <Caret className="text-doom-faint" />
      </button>

      <button
        type="button"
        data-testid="axis-minor"
        onClick={() => setMinorOpen((open) => !open)}
        className={`flex h-[21px] items-center gap-1.5 rounded-[3px] px-2 ${
          activeMinors.length > 0 ? 'bg-[#2E2136] text-doom-magenta' : 'border border-doom-border text-doom-faint'
        }`}
      >
        <span data-testid="minor-summary" className="text-[10px] font-bold">
          {activeMinors[0]?.name ?? 'minor'}
        </span>
        {activeMinors.length > 1 ? <span className="text-[9px]">+{activeMinors.length - 1}</span> : null}
        <Caret className={activeMinors.length > 0 ? 'text-doom-magenta' : 'text-doom-faint'} />
      </button>

      <button
        type="button"
        data-testid="axis-domains"
        onClick={() => ask('domains')}
        className="flex h-[21px] min-w-0 items-center gap-1.5 rounded-[3px] border border-doom-border px-2"
      >
        <span
          data-testid="selection-domains"
          className={`truncate text-[10px] ${selection.domains.length > 0 ? 'text-doom-violet' : 'text-doom-faint'}`}
        >
          {selection.domains.length > 0 ? selection.domains.join(', ') : 'no domains'}
        </span>
        <Caret className="text-doom-faint" />
      </button>

      <div className="min-w-0 flex-1" />

      <div className="flex h-[21px] items-center gap-1.5 rounded-[3px] border border-doom-border px-2">
        <span data-testid="agent-model" className="text-[10px] text-doom-hi">
          {agent?.model ?? '—'}
        </span>
        <span data-testid="agent-thinking" className="text-[10px] text-doom-yellow">
          {agent?.thinkingLevel ?? ''}
        </span>
      </div>
      <span data-testid="top-context" className="text-[10px] text-doom-dim">
        {stats?.contextPercent === null || stats === null ? 'ctx —' : `ctx ${Math.round(stats.contextPercent)}%`}
      </span>
      <span data-testid="top-cost" className="text-[10px] text-doom-dim">
        {stats ? `$${stats.cost.toFixed(2)}` : ''}
      </span>

      {minorOpen ? <MinorModesPopup modes={modes} onClose={() => setMinorOpen(false)} /> : null}
    </footer>
  );
}
