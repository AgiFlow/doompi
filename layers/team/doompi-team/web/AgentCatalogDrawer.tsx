import { Badge, Button, CloseIcon, Input, Kbd } from '@agimon-ai/doompi-web-components';
import { useStore } from '@tanstack/react-store';
import type { KeyboardEvent as ReactKeyboardEvent } from 'react';
import type { SubagentCatalogAgent } from '../src/types/webSubagents.ts';
import { catalog, selectAgent, setCatalogFilter, toggleInspect } from './catalogStore.ts';
import { agentMeta, filterCatalog, groupCatalog } from './launchCommand.ts';

const INPUT_TAG = 'INPUT';

function shortModel(model: string): string {
  return model.split('/').pop() ?? model;
}

/** The unfolded row: what the definition names, read-only, the way the TUI catalog's tabs show it. */
function Resources({ agent }: { agent: SubagentCatalogAgent }) {
  const rows: Array<[string, string]> = [
    ['tools', agent.tools.length > 0 ? agent.tools.join(', ') : 'every tool the session has'],
    ['skills', agent.skills.length > 0 ? agent.skills.join(', ') : 'none named'],
    ['extensions', agent.extensions.length > 0 ? agent.extensions.join(', ') : 'none named'],
    ['model', agent.model ?? 'runtime default'],
    ['file', agent.filePath],
  ];
  return (
    <dl data-testid={`catalog-resources-${agent.name}`} className="flex flex-col gap-1 pt-1 text-[9px]">
      {rows.map(([label, value]) => (
        <div key={label} className="flex gap-2">
          <dt className="w-16 shrink-0 text-doom-faint">{label}</dt>
          <dd className="min-w-0 break-words text-doom-dim">{value}</dd>
        </div>
      ))}
    </dl>
  );
}

function AgentRow({
  agent,
  selected,
  inspected,
  onSelect,
  onLaunch,
  onInspect,
}: {
  agent: SubagentCatalogAgent;
  selected: boolean;
  inspected: boolean;
  onSelect: () => void;
  onLaunch: (fork: boolean) => void;
  onInspect: () => void;
}) {
  // A div rather than a button: the selected row carries buttons of its own.
  return (
    <div
      role="option"
      aria-selected={selected}
      tabIndex={-1}
      data-testid={`catalog-agent-${agent.name}`}
      data-selected={selected}
      onClick={onSelect}
      onDoubleClick={() => onLaunch(false)}
      className={`flex cursor-pointer flex-col gap-1 border-l-2 px-4 py-2 ${
        selected ? 'border-doom-blue bg-doom-panel' : 'border-transparent hover:bg-doom-panel/60'
      }`}
    >
      <div className="flex min-w-0 items-center gap-2">
        <span className="truncate text-[12px] font-bold text-doom-hi">{agent.name}</span>
        <Badge size="xs" className="shrink-0">
          {agent.packageName ?? agent.source}
        </Badge>
        <span className="min-w-0 flex-1" />
        <span className={`shrink-0 text-[9px] ${agent.model ? 'text-doom-cyan' : 'text-doom-faint'}`}>
          {agent.model ? shortModel(agent.model) : 'agent default'}
        </span>
      </div>
      <span className="truncate text-[10px] text-doom-dim">{agent.description}</span>
      <span className="truncate text-[9px] text-doom-faint">{agentMeta(agent)}</span>
      {selected ? (
        <div className="flex items-center gap-3 pt-0.5">
          <Button
            variant="link"
            size="xs"
            data-testid={`catalog-launch-${agent.name}`}
            className="px-0"
            onClick={(event) => {
              event.stopPropagation();
              onLaunch(false);
            }}
          >
            launch <Kbd>↵</Kbd>
          </Button>
          <Button
            variant="link"
            size="xs"
            data-testid={`catalog-fork-${agent.name}`}
            className="px-0 text-doom-dim"
            onClick={(event) => {
              event.stopPropagation();
              onLaunch(true);
            }}
          >
            fork session <Kbd>f</Kbd>
          </Button>
          <Button
            variant="link"
            size="xs"
            data-testid={`catalog-inspect-${agent.name}`}
            className="px-0 text-doom-dim"
            onClick={(event) => {
              event.stopPropagation();
              onInspect();
            }}
          >
            inspect <Kbd>i</Kbd>
          </Button>
        </div>
      ) : null}
      {selected && inspected ? <Resources agent={agent} /> : null}
    </div>
  );
}

/**
 * The agent catalog, in the subagents tab's drawer: every agent the session's
 * directory can launch, nearest definition first, with a filter and keys the
 * TUI catalog also answers to. Launching hands the chosen agent to the dialog.
 */
export function AgentCatalogDrawer({
  sessionId,
  onClose,
  onLaunch,
}: {
  sessionId: string;
  onClose: () => void;
  onLaunch: (agent: SubagentCatalogAgent, fork: boolean) => void;
}) {
  const state = useStore(catalog.store, (current) => catalog.select(current, sessionId));
  const shown = filterCatalog(state.agents, state.filter);
  const sections = groupCatalog(shown);
  const selected = shown.find((agent) => agent.name === state.selected) ?? shown[0];

  const move = (delta: number): void => {
    if (shown.length === 0) return;
    const index = selected === undefined ? -1 : shown.findIndex((agent) => agent.name === selected.name);
    const next = shown[(index + delta + shown.length) % shown.length];
    if (next) selectAgent(sessionId, next.name);
  };

  const onKeyDown = (event: ReactKeyboardEvent<HTMLElement>): void => {
    const typing = (event.target as HTMLElement).tagName === INPUT_TAG;
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      move(event.key === 'ArrowDown' ? 1 : -1);
      return;
    }
    if (event.key === 'Escape') {
      event.preventDefault();
      onClose();
      return;
    }
    if (selected === undefined) return;
    if (event.key === 'Enter') {
      event.preventDefault();
      onLaunch(selected, false);
      return;
    }
    if (typing) return;
    if (event.key === 'f') onLaunch(selected, true);
    if (event.key === 'i') toggleInspect(sessionId, selected.name);
  };

  return (
    <aside
      data-testid="catalog-drawer"
      tabIndex={0}
      onKeyDown={onKeyDown}
      className="flex w-[440px] shrink-0 flex-col overflow-hidden border-l border-doom-border bg-doom-rail outline-none"
    >
      <div className="flex h-11 shrink-0 items-center gap-2.5 border-b border-doom-border px-4">
        <span className="text-[13px] font-bold text-doom-hi">agent catalog</span>
        <Badge size="xs" data-testid="catalog-count">
          {state.agents.length} agent{state.agents.length === 1 ? '' : 's'}
        </Badge>
        <span className="min-w-0 flex-1" />
        <Kbd>SPC a l</Kbd>
        <Button variant="ghost" size="icon" data-testid="catalog-close" title="close the catalog" onClick={onClose}>
          <CloseIcon className="h-3 w-3" />
        </Button>
      </div>
      <div className="px-4 pt-2.5 pb-1.5">
        <Input
          data-testid="catalog-filter"
          value={state.filter}
          placeholder="filter by name, source, or tool…"
          autoFocus
          onChange={(event) => setCatalogFilter(sessionId, event.target.value)}
        />
      </div>
      <div role="listbox" className="flex min-h-0 flex-1 flex-col overflow-y-auto pb-2">
        {shown.length === 0 ? (
          <p data-testid="catalog-empty" className="px-4 py-3 text-[10px] text-doom-faint">
            {state.warning ??
              (state.agents.length === 0
                ? 'no agents found for this session; add one under .doom/agents or ~/.doompi/agent/agents'
                : 'nothing matches the filter')}
          </p>
        ) : null}
        {sections.map((section) => (
          <div key={section.source} className="flex flex-col">
            <span className="px-4 pt-2.5 pb-1 text-[9px] font-bold tracking-[0.18em] text-doom-faint">
              {section.label}
            </span>
            {section.agents.map((agent) => (
              <AgentRow
                key={agent.name}
                agent={agent}
                selected={selected?.name === agent.name}
                inspected={state.inspected === agent.name}
                onSelect={() => selectAgent(sessionId, agent.name)}
                onLaunch={(fork) => onLaunch(agent, fork)}
                onInspect={() => toggleInspect(sessionId, agent.name)}
              />
            ))}
          </div>
        ))}
      </div>
      <div className="flex h-8 shrink-0 items-center justify-between border-t border-doom-border-soft bg-doom-deep px-4">
        <span className="text-[9px] text-doom-faint">↑↓ choose · enter launch · f fork · i inspect · esc close</span>
        <span className="text-[9px] text-doom-faint">
          {sections.length} source{sections.length === 1 ? '' : 's'}
        </span>
      </div>
    </aside>
  );
}
