import { useEffect, useRef, useState } from 'react';
import { useStore } from '@tanstack/react-store';
import { PluginSurface } from '../../components/PluginSurface.tsx';
import { minorModes, type MinorMode, selectionAxes } from '../../lib/composition.ts';
import type { AgentInfo, ModelChoice } from '../../lib/sessionModel.ts';
import { parseSelection } from '../../lib/statusLine.ts';
import { setPendingMenu } from '../../stores/menuStore.ts';
import {
  loadModelChoices,
  runCommand,
  selectModel,
  selectThinkingLevel,
  useActiveSession,
} from '../../stores/sessionStore.ts';
import { sessionsStore } from '../../stores/sessionsStore.ts';

function Caret({ className }: { className: string }) {
  return (
    <svg viewBox="0 0 10 10" className={`h-[10px] w-[10px] shrink-0 ${className}`} aria-hidden>
      <path d="M2 3.5 L5 6.5 L8 3.5" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
    </svg>
  );
}

// The mockup's colour per axis; a plugin axis the host has no entry for reads
// in the neutral tone.
const AXIS_TONE: Readonly<Record<string, string>> = {
  profile: 'text-doom-green',
  domains: 'text-doom-violet',
};

const AVAILABILITY_TONE: Readonly<Record<MinorMode['availability'], string>> = {
  on: 'text-doom-hi',
  off: 'text-doom-dim',
  unavailable: 'text-doom-faint/60',
};

/**
 * The minor-modes popup: state is derived from the statuses the session
 * already published, and every row is a button that hands the mode to the
 * runtime's /minor command. The runtime owns what happens next: a mode with
 * one opt-in toggles outright, one with several opens its action picker as a
 * dialog, and modes compose, so any number can be on at once.
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
          <button
            key={mode.name}
            type="button"
            data-testid={`minor-${mode.name}`}
            data-availability={mode.availability}
            title={`toggle ${mode.name}`}
            onClick={() => {
              runCommand(`/minor ${mode.id}`);
              onClose();
            }}
            className={`flex w-full items-center gap-2.5 rounded-[5px] px-2 py-1.5 text-left hover:bg-doom-deep ${mode.availability === 'on' ? 'bg-[#2E2136] hover:bg-[#382842]' : ''}`}
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
          </button>
        ))}
      </div>
      <div className="flex h-[30px] items-center border-t border-doom-border-soft bg-doom-deep px-3">
        <span className="text-[9px] text-doom-faint">
          click to toggle · a mode with several opt-ins asks · esc closes
        </span>
      </div>
    </div>
  );
}

/**
 * The model popup: the models Pi can switch to and the thinking levels the
 * current model accepts, both asked for on open because Pi only reports them
 * on request. A pick goes straight to the RPC verbs; the chip updates from the
 * get_state that follows, so it never shows a choice the agent refused.
 */
function ModelPopup({
  agent,
  models,
  levels,
  onClose,
}: {
  agent: AgentInfo | null;
  models: ModelChoice[];
  levels: string[];
  onClose: () => void;
}) {
  const surface = useRef<HTMLDivElement>(null);
  const [filter, setFilter] = useState('');

  useEffect(() => {
    loadModelChoices();
    surface.current?.querySelector('input')?.focus();
  }, []);

  const needle = filter.trim().toLowerCase();
  const shown = needle
    ? models.filter((model) => `${model.provider} ${model.id} ${model.name}`.toLowerCase().includes(needle))
    : models;

  return (
    <div
      ref={surface}
      tabIndex={-1}
      data-testid="model-popup"
      onKeyDown={(event) => {
        if (event.key === 'Escape') onClose();
      }}
      onBlur={(event) => {
        if (!surface.current?.contains(event.relatedTarget as Node | null)) onClose();
      }}
      className="absolute bottom-[28px] right-0 z-30 w-[400px] overflow-hidden rounded-lg border border-[#4A4A33] bg-doom-panel shadow-2xl outline-none"
    >
      <div className="flex h-[34px] items-center justify-between border-b border-doom-border-soft bg-doom-deep px-3">
        <span className="text-[10px] font-bold tracking-wide text-doom-yellow">MODEL</span>
        <span className="text-[9px] text-doom-faint">{agent ? `${agent.provider}/${agent.model}` : ''}</span>
      </div>
      <div className="border-b border-doom-border-soft p-1.5">
        <input
          data-testid="model-filter"
          value={filter}
          placeholder="filter models…"
          onChange={(event) => setFilter(event.target.value)}
          className="w-full rounded border border-doom-border bg-doom-deep px-2 py-1 text-[11px] text-doom-hi outline-none placeholder:text-doom-faint"
        />
      </div>
      <div className="flex max-h-[260px] flex-col gap-0.5 overflow-y-auto p-1.5">
        {models.length === 0 ? (
          <span className="px-2 py-1.5 text-[10px] text-doom-faint">asking the session for its models…</span>
        ) : shown.length === 0 ? (
          <span className="px-2 py-1.5 text-[10px] text-doom-faint">no model matches</span>
        ) : null}
        {shown.map((model) => {
          const current = agent?.model === model.id && agent.provider === model.provider;
          return (
            <button
              key={`${model.provider}/${model.id}`}
              type="button"
              data-testid={`model-${model.provider}-${model.id}`}
              data-current={current}
              onClick={() => {
                selectModel(model.provider, model.id);
                onClose();
              }}
              className={`flex w-full items-center gap-2.5 rounded-[5px] px-2 py-1.5 text-left hover:bg-doom-deep ${current ? 'bg-[#33321F] hover:bg-[#3E3D26]' : ''}`}
            >
              <span className="w-20 shrink-0 truncate text-[9px] text-doom-faint">{model.provider}</span>
              <span className={`flex-1 truncate text-[12px] ${current ? 'text-doom-yellow' : 'text-doom-hi'}`}>
                {model.id}
              </span>
              {model.reasoning ? <span className="text-[8px] text-doom-faint">thinks</span> : null}
              <span
                className={`h-1.5 w-1.5 shrink-0 rounded-full ${current ? 'bg-doom-yellow' : 'bg-doom-faint/40'}`}
              />
            </button>
          );
        })}
      </div>
      <div className="flex min-h-[34px] flex-wrap items-center gap-1 border-t border-doom-border-soft bg-doom-deep px-3 py-1.5">
        <span className="mr-1 text-[9px] font-bold tracking-wide text-doom-faint">THINKING</span>
        {levels.length === 0 ? <span className="text-[9px] text-doom-faint">…</span> : null}
        {levels.map((level) => {
          const current = agent?.thinkingLevel === level;
          return (
            <button
              key={level}
              type="button"
              data-testid={`thinking-${level}`}
              data-current={current}
              onClick={() => {
                selectThinkingLevel(level);
                onClose();
              }}
              className={`rounded px-1.5 py-0.5 text-[10px] ${
                current
                  ? 'bg-doom-yellow/25 font-bold text-doom-yellow'
                  : 'text-doom-dim hover:bg-doom-panel hover:text-doom-hi'
              }`}
            >
              {level}
            </button>
          );
        })}
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
  const activeId = useStore(sessionsStore, (state) => state.activeId);
  const raw = useActiveSession((state) => state.statuses['doom-major-mode'] ?? '');
  const statuses = useActiveSession((state) => state.statuses);
  const widgets = useActiveSession((state) => state.widgets);
  const catalog = useActiveSession((state) => state.minorModes);
  const agent = useActiveSession((state) => state.agent);
  const stats = useActiveSession((state) => state.stats);
  const models = useActiveSession((state) => state.models);
  const thinkingLevels = useActiveSession((state) => state.thinkingLevels);
  const [minorOpen, setMinorOpen] = useState(false);
  const [modelOpen, setModelOpen] = useState(false);

  const selection = parseSelection(raw);
  const axes = selectionAxes(statuses);
  const modes = minorModes(statuses, widgets, catalog);
  const activeMinors = modes.filter((mode) => mode.availability === 'on');

  const ask = (menu: string, command: string): void => {
    setPendingMenu(menu);
    runCommand(command);
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
        onClick={() => ask('mode', 'mode')}
        className={`flex h-[21px] items-center gap-1.5 rounded-[3px] px-2 ${
          selection.pending ? 'bg-doom-yellow' : 'bg-doom-blue'
        } text-doom-rail`}
      >
        <span data-testid="selection-mode" className="text-[10px] font-bold tracking-[0.08em]">
          {(selection.majorMode || 'mode').toUpperCase()}
        </span>
        <Caret className="text-doom-rail" />
      </button>

      {axes.map((axis) => (
        <button
          key={axis.name}
          type="button"
          data-testid={`axis-${axis.name}`}
          onClick={() => ask(axis.name, axis.command)}
          className="flex h-[21px] min-w-0 items-center gap-1.5 rounded-[3px] border border-doom-border px-2"
        >
          <span
            data-testid={`selection-${axis.name}`}
            className={`truncate text-[10px] ${axis.multi ? '' : 'font-bold'} ${
              axis.values.length > 0 ? (AXIS_TONE[axis.name] ?? 'text-doom-hi') : 'text-doom-faint'
            }`}
          >
            {axis.values.length === 0 ? axis.emptyLabel : axis.multi ? axis.values.join(', ') : `*${axis.values[0]}*`}
          </span>
          <Caret className="text-doom-faint" />
        </button>
      ))}

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

      <PluginSurface slot="selectionBar" sessionId={activeId} />

      <div className="min-w-0 flex-1" />

      <div className="relative">
        <button
          type="button"
          data-testid="axis-model"
          onClick={() => setModelOpen((open) => !open)}
          className="flex h-[21px] items-center gap-1.5 rounded-[3px] border border-doom-border px-2"
        >
          <span data-testid="agent-model" className="text-[10px] text-doom-hi">
            {agent?.model ?? '—'}
          </span>
          <span data-testid="agent-thinking" className="text-[10px] text-doom-yellow">
            {agent?.thinkingLevel ?? ''}
          </span>
          <Caret className="text-doom-faint" />
        </button>
        {modelOpen ? (
          <ModelPopup agent={agent} models={models} levels={thinkingLevels} onClose={() => setModelOpen(false)} />
        ) : null}
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
