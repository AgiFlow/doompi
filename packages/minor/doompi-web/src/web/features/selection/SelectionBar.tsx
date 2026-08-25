import {
  Button,
  buttonVariants,
  ChevronDownIcon,
  cn,
  Dot,
  EmptyState,
  handleOptionListKey,
  Input,
  Kbd,
  OptionLabel,
  OptionList,
  optionListHint,
  OptionRow,
  Popover,
  PopoverAnchor,
  PopoverContent,
  PopoverFooter,
  PopoverHeader,
  PopoverTrigger,
  SectionLabel,
  Spinner,
} from '@agimon-ai/doompi-web-components';
import { useStore } from '@tanstack/react-store';
import { useEffect, useState } from 'react';
import { PluginSurface } from '../../components/PluginSurface.tsx';
import { HOST_SLOTS } from '../../lib/pluginRegistry.ts';
import { minorModes, type MinorMode, selectionAxes } from '../../lib/composition.ts';
import type { AgentInfo, DialogRequest, ModelChoice } from '../../lib/sessionModel.ts';
import { focusPrompt } from '../../lib/promptFocus.ts';
import { parseSelection } from '../../lib/statusLine.ts';
import { menuStore, setPendingMenu } from '../../stores/menuStore.ts';
import {
  answerDialogValue,
  cancelDialog,
  loadModelChoices,
  runCommand,
  selectModel,
  selectThinkingLevel,
  useActiveSession,
} from '../../stores/sessionStore.ts';
import { sessionsStore } from '../../stores/sessionsStore.ts';

// The known axes keep their mockup styling; a plugin-declared axis the host
// has no entry for reads in the neutral tone.
const AXIS_TONE: Readonly<Record<string, string>> = {
  profile: 'text-doom-green',
  domains: 'text-doom-violet',
};

const MENU_TITLE: Readonly<Record<string, string>> = {
  mode: 'MAJOR MODE',
  profile: 'PROFILE',
  domains: 'DOMAINS',
  minor: 'MINOR MODES',
};

const MENU_ACCENT: Readonly<Record<string, { border: string; title: string }>> = {
  mode: { border: 'border-doom-edge-blue', title: 'text-doom-blue' },
  profile: { border: 'border-doom-edge-green', title: 'text-doom-green' },
  domains: { border: 'border-doom-edge-violet', title: 'text-doom-violet' },
  minor: { border: 'border-doom-edge-magenta', title: 'text-doom-magenta' },
};

const DEFAULT_ACCENT = { border: 'border-doom-border', title: 'text-doom-hi' };

const AVAILABILITY_TONE: Readonly<Record<MinorMode['availability'], string>> = {
  on: 'text-doom-hi',
  off: 'text-doom-dim',
  unavailable: 'text-doom-faint/60',
};

/**
 * A select the user asked for from this bar, rendered as the button's own
 * popover rather than a centered modal: the question came from here, so the
 * answer belongs here. It is the same dialog and the same replies; only the
 * frame differs.
 */
function AxisMenu({ menu, dialog }: { menu: string; dialog: DialogRequest }) {
  const accent = MENU_ACCENT[menu] ?? DEFAULT_ACCENT;
  const [cursor, setCursor] = useState(0);
  return (
    <PopoverContent
      side="top"
      align="start"
      data-testid="dialog"
      data-dialog-method={dialog.method}
      data-dialog-menu={menu}
      onCloseAutoFocus={(event) => {
        event.preventDefault();
        focusPrompt();
      }}
      onKeyDown={(event) =>
        handleOptionListKey(event, {
          options: dialog.options,
          cursor,
          onCursorChange: setCursor,
          onSelect: (option) => answerDialogValue(dialog.id, option),
        })
      }
      className={`w-[420px] ${accent.border}`}
    >
      <PopoverHeader>
        <span data-testid="dialog-title" className={`text-[10px] font-bold tracking-wide ${accent.title}`}>
          {MENU_TITLE[menu] ?? menu.toUpperCase()}
        </span>
        <span className="truncate text-[9px] text-doom-faint">{dialog.title}</span>
      </PopoverHeader>
      <div className="flex max-h-[320px] min-h-0 flex-col">
        <OptionList
          options={dialog.options}
          cursor={cursor}
          onCursorChange={setCursor}
          density="compact"
          testIdPrefix="dialog-option"
          onSelect={(option) => answerDialogValue(dialog.id, option)}
        />
      </div>
      <PopoverFooter>
        <span data-testid="dialog-hints" className="flex items-center gap-1.5">
          {optionListHint(dialog.options.length)} · <Kbd>esc</Kbd> closes
        </span>
        <Button variant="ghost" size="xs" data-testid="dialog-cancel" onClick={() => cancelDialog(dialog.id)}>
          cancel
        </Button>
      </PopoverFooter>
    </PopoverContent>
  );
}

/**
 * One selection axis: a button that asks the agent, and the menu the agent
 * answers with. While the question is in flight the button says so, because
 * the round trip runs through the session and can take a moment.
 */
function AxisButton({
  name,
  command,
  pending,
  claimedDialog,
  children,
  className,
}: {
  name: string;
  command: string;
  pending: boolean;
  claimedDialog: DialogRequest | null;
  children: React.ReactNode;
  className: string;
}) {
  const open = claimedDialog !== null;
  return (
    <Popover
      open={open}
      onOpenChange={(next) => {
        if (!next && claimedDialog) cancelDialog(claimedDialog.id);
      }}
    >
      <PopoverAnchor asChild>
        <Button
          data-testid={`axis-${name}`}
          data-pending={pending}
          aria-haspopup="menu"
          aria-expanded={open}
          title={pending ? `asking the session for ${name}…` : `change ${name}`}
          onClick={() => {
            setPendingMenu(name);
            runCommand(command);
          }}
          className={className}
        >
          {children}
          {pending ? <Spinner className="h-[10px] w-[10px]" /> : <ChevronDownIcon className="h-[10px] w-[10px]" />}
        </Button>
      </PopoverAnchor>
      {claimedDialog ? <AxisMenu menu={name} dialog={claimedDialog} /> : null}
    </Popover>
  );
}

/**
 * The minor-modes popup: state is derived from the statuses the session
 * already published, and every row is a button that hands the mode to the
 * runtime's /minor command. The runtime owns what happens next: a mode with
 * one opt-in toggles outright, one with several opens its action picker as a
 * dialog, and modes compose, so any number can be on at once.
 */
function MinorModesPopup({ modes, onClose }: { modes: MinorMode[]; onClose: () => void }) {
  const on = modes.filter((mode) => mode.availability === 'on').length;
  return (
    <PopoverContent side="top" align="start" data-testid="minor-popup" className="w-[430px] border-doom-edge-magenta">
      <PopoverHeader>
        <SectionLabel className="tracking-wide text-doom-magenta">minor modes</SectionLabel>
        <span className="text-[9px] text-doom-faint">{on} on</span>
      </PopoverHeader>
      <div
        role="listbox"
        aria-label="minor modes"
        className="flex max-h-[320px] flex-col gap-0.5 overflow-y-auto p-1.5"
      >
        {modes.map((mode) => (
          <OptionRow
            key={mode.name}
            density="compact"
            active={mode.availability === 'on'}
            data-testid={`minor-${mode.name}`}
            data-availability={mode.availability}
            // A mode that cannot run here says so on hover instead of taking a
            // click and answering with a notice after the round trip.
            disabled={mode.availability === 'unavailable'}
            title={mode.availability === 'unavailable' ? mode.unavailableReason : `drive ${mode.name}`}
            onClick={() => {
              // The runtime may answer with an opt-in picker; claiming the menu
              // keeps that question on this chip, where it was asked, instead
              // of throwing it to the middle of the screen.
              setPendingMenu('minor');
              runCommand(`/minor ${mode.id}`);
              onClose();
            }}
            className={cn(
              'w-full gap-2.5 py-1.5 transition-colors hover:bg-doom-deep focus-visible:bg-doom-deep disabled:cursor-not-allowed',
              mode.availability === 'on' && 'bg-doom-tint-magenta hover:brightness-125',
            )}
          >
            <Kbd
              className={`w-8 justify-center ${
                mode.availability === 'on' ? 'bg-doom-magenta/25 text-doom-magenta' : ''
              }`}
            >
              {mode.keys}
            </Kbd>
            <OptionLabel density="compact" className={AVAILABILITY_TONE[mode.availability]}>
              {mode.name}
            </OptionLabel>
            {mode.detail ? (
              <span data-testid={`minor-detail-${mode.name}`} className="truncate text-[9px] text-doom-magenta">
                {mode.detail}
              </span>
            ) : null}
            {mode.availability === 'unavailable' && mode.unavailableReason ? (
              <span
                data-testid={`minor-reason-${mode.name}`}
                className="min-w-0 flex-1 truncate text-right text-[9px] text-doom-faint/70"
              >
                {mode.unavailableReason}
              </span>
            ) : null}
            {mode.availability === 'unavailable' ? (
              <span className="shrink-0 text-[8px] text-doom-faint/60">n/a</span>
            ) : (
              <Dot tone={mode.availability === 'on' ? 'magenta' : 'muted'} />
            )}
          </OptionRow>
        ))}
      </div>
      <PopoverFooter>
        <span>click drives a mode · one with several opt-ins asks · esc closes</span>
      </PopoverFooter>
    </PopoverContent>
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
  const [filter, setFilter] = useState('');

  useEffect(() => {
    loadModelChoices();
  }, []);

  const needle = filter.trim().toLowerCase();
  const shown = needle
    ? models.filter((model) => `${model.provider} ${model.id} ${model.name}`.toLowerCase().includes(needle))
    : models;

  return (
    <PopoverContent side="top" align="end" data-testid="model-popup" className="w-[400px] border-doom-edge-yellow">
      <PopoverHeader>
        <SectionLabel className="tracking-wide text-doom-yellow">model</SectionLabel>
        <span className="truncate text-[9px] text-doom-faint">{agent ? `${agent.provider}/${agent.model}` : ''}</span>
      </PopoverHeader>
      <div className="border-b border-doom-border-soft p-1.5">
        <Input
          data-testid="model-filter"
          value={filter}
          autoFocus
          placeholder="filter models…"
          onChange={(event) => setFilter(event.target.value)}
          className="w-full px-2 py-1 text-[11px]"
        />
      </div>
      <div role="listbox" aria-label="models" className="flex max-h-[260px] flex-col gap-0.5 overflow-y-auto p-1.5">
        {models.length === 0 ? (
          <span className="flex items-center gap-2 px-2 py-1.5 text-[10px] text-doom-faint">
            <Spinner label="asking the session for its models" />
            asking the session for its models…
          </span>
        ) : shown.length === 0 ? (
          <EmptyState className="py-4" title="no model matches" />
        ) : null}
        {shown.map((model) => {
          const current = agent?.model === model.id && agent.provider === model.provider;
          return (
            <OptionRow
              key={`${model.provider}/${model.id}`}
              density="compact"
              active={current}
              data-testid={`model-${model.provider}-${model.id}`}
              data-current={current}
              onClick={() => {
                selectModel(model.provider, model.id);
                onClose();
              }}
              className={cn(
                'w-full gap-2.5 py-1.5 transition-colors hover:bg-doom-deep focus-visible:bg-doom-deep',
                current && 'bg-doom-tint-yellow hover:brightness-125',
              )}
            >
              <span className="w-20 shrink-0 truncate text-[9px] text-doom-faint">{model.provider}</span>
              <OptionLabel density="compact" className={current ? 'text-doom-yellow' : 'text-doom-hi'}>
                {model.id}
              </OptionLabel>
              {model.reasoning ? <span className="text-[8px] text-doom-faint">thinks</span> : null}
              <Dot tone={current ? 'yellow' : 'muted'} />
            </OptionRow>
          );
        })}
      </div>
      <PopoverFooter className="flex-wrap justify-start gap-1 py-1.5">
        <SectionLabel className="mr-1 tracking-wide">thinking</SectionLabel>
        {levels.length === 0 ? <span className="text-[9px] text-doom-faint">…</span> : null}
        {levels.map((level) => {
          const current = agent?.thinkingLevel === level;
          return (
            <Button
              key={level}
              variant="ghost"
              size="xs"
              data-testid={`thinking-${level}`}
              data-current={current}
              onClick={() => {
                selectThinkingLevel(level);
                onClose();
              }}
              className={cn(
                'text-[10px]',
                current && 'bg-doom-yellow/25 font-bold text-doom-yellow hover:bg-doom-yellow/25',
              )}
            >
              {level}
            </Button>
          );
        })}
      </PopoverFooter>
    </PopoverContent>
  );
}

/**
 * The mockup's bottom bar: the DoomPi selection axes as buttons, the model,
 * and the context gauge. Buttons route through the same slash commands the
 * TUI uses; the agent's select dialog then opens as that button's popover.
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
  const dialog = useActiveSession((state) => state.dialog);
  const pendingMenu = useStore(menuStore, (state) => state.pending);
  const claimed = useStore(menuStore, (state) => state.claimed);
  const [minorOpen, setMinorOpen] = useState(false);
  const [modelOpen, setModelOpen] = useState(false);

  const selection = parseSelection(raw);
  const axes = selectionAxes(statuses);
  const modes = minorModes(statuses, widgets, catalog);
  const activeMinors = modes.filter((mode) => mode.availability === 'on');

  /** The dialog this axis asked for, when the claim named it and it is still open. */
  const dialogFor = (name: string): DialogRequest | null =>
    dialog !== null && claimed !== null && claimed.dialogId === dialog.id && claimed.menu === name ? dialog : null;
  const minorDialog = dialogFor('minor');

  const modeClass = cn(
    buttonVariants({ variant: 'primary', size: 'sm' }),
    'h-[21px] rounded-[3px] px-2 text-doom-rail',
    selection.pending && 'bg-doom-yellow',
  );
  const axisClass = cn(buttonVariants({ variant: 'outline', size: 'sm' }), 'h-[21px] min-w-0 rounded-[3px] px-2');

  return (
    <footer
      data-testid="selection-bar"
      data-pending={selection.pending}
      className="relative flex h-[34px] shrink-0 items-center gap-2 border-t border-doom-border bg-doom-rail px-3.5"
    >
      <AxisButton
        name="mode"
        command="mode"
        pending={pendingMenu === 'mode'}
        claimedDialog={dialogFor('mode')}
        className={modeClass}
      >
        <span data-testid="selection-mode" className="text-[10px] font-bold tracking-[0.08em]">
          {(selection.majorMode || 'mode').toUpperCase()}
        </span>
      </AxisButton>

      {axes.map((axis) => (
        <AxisButton
          key={axis.name}
          name={axis.name}
          command={axis.command}
          pending={pendingMenu === axis.name}
          claimedDialog={dialogFor(axis.name)}
          className={axisClass}
        >
          <span
            data-testid={`selection-${axis.name}`}
            className={`truncate text-[10px] ${axis.multi ? '' : 'font-bold'} ${
              axis.values.length > 0 ? (AXIS_TONE[axis.name] ?? 'text-doom-hi') : 'text-doom-faint'
            }`}
          >
            {axis.values.length === 0 ? axis.emptyLabel : axis.multi ? axis.values.join(', ') : `*${axis.values[0]}*`}
          </span>
        </AxisButton>
      ))}

      <Popover
        open={minorOpen || minorDialog !== null}
        onOpenChange={(next) => {
          if (next) {
            setMinorOpen(true);
            return;
          }
          if (minorDialog) cancelDialog(minorDialog.id);
          setMinorOpen(false);
        }}
      >
        <PopoverTrigger asChild>
          <Button
            data-testid="axis-minor"
            title="minor modes"
            variant={activeMinors.length > 0 ? 'subtle' : 'outline'}
            size="sm"
            className={cn(
              'h-[21px] rounded-[3px] px-2',
              activeMinors.length > 0
                ? 'bg-doom-tint-magenta text-doom-magenta hover:bg-doom-tint-magenta hover:brightness-125'
                : 'text-doom-faint',
            )}
          >
            <span data-testid="minor-summary" className="text-[10px] font-bold">
              {activeMinors[0]?.name ?? 'minor'}
            </span>
            {activeMinors.length > 1 ? <span className="text-[9px]">+{activeMinors.length - 1}</span> : null}
            <ChevronDownIcon className="h-[10px] w-[10px]" />
          </Button>
        </PopoverTrigger>
        {minorDialog ? (
          <AxisMenu menu="minor" dialog={minorDialog} />
        ) : minorOpen ? (
          <MinorModesPopup modes={modes} onClose={() => setMinorOpen(false)} />
        ) : null}
      </Popover>

      <PluginSurface slot={HOST_SLOTS.selectionBar} sessionId={activeId} />

      <div className="min-w-0 flex-1" />

      <Popover open={modelOpen} onOpenChange={setModelOpen}>
        <PopoverTrigger asChild>
          <Button data-testid="axis-model" title="model and thinking level" className={axisClass}>
            <span data-testid="agent-model" className="text-[10px] text-doom-hi">
              {agent?.model ?? '—'}
            </span>
            <span data-testid="agent-thinking" className="text-[10px] text-doom-yellow">
              {agent?.thinkingLevel ?? ''}
            </span>
            <ChevronDownIcon className="h-[10px] w-[10px] text-doom-faint" />
          </Button>
        </PopoverTrigger>
        {modelOpen ? (
          <ModelPopup agent={agent} models={models} levels={thinkingLevels} onClose={() => setModelOpen(false)} />
        ) : null}
      </Popover>

      <span
        data-testid="top-context"
        title={
          stats?.contextTokens != null && stats.contextWindow != null
            ? `${stats.contextTokens.toLocaleString()} of ${stats.contextWindow.toLocaleString()} tokens`
            : 'context usage, once the session reports it'
        }
        className="text-[10px] text-doom-dim"
      >
        {stats?.contextPercent == null ? 'ctx —' : `ctx ${Math.round(stats.contextPercent)}%`}
      </span>
      <span
        data-testid="top-cost"
        title={stats ? `${stats.totalTokens.toLocaleString()} tokens this session` : ''}
        className="text-[10px] text-doom-dim"
      >
        {stats ? `$${stats.cost.toFixed(2)}` : ''}
      </span>
    </footer>
  );
}
