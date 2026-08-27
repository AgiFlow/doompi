import { Badge, Button, CloseIcon, Input, Kbd } from '@agimon-ai/doompi-web-components';
import { useStore } from '@tanstack/react-store';
import type { KeyboardEvent as ReactKeyboardEvent } from 'react';
import type { WorkflowCatalogEntryView } from '../src/types/webWorkflows.ts';
import { catalog, filterCatalog, selectWorkflow, setCatalogFilter, toggleInspect } from './catalogStore.ts';

const INPUT_TAG = 'INPUT';

/** The unfolded row: what the file declares, read-only, as the TUI catalog's tabs show it. */
function Detail({ workflow }: { workflow: WorkflowCatalogEntryView }) {
  const rows: Array<[string, string]> = [
    ['triggers', workflow.triggers.length > 0 ? workflow.triggers.join(', ') : 'none declared'],
    [
      'inputs',
      workflow.inputs.length > 0
        ? workflow.inputs
            .map((input) => `${input.name}${input.required ? '*' : ''}${input.default ? ` = ${input.default}` : ''}`)
            .join(', ')
        : 'none declared',
    ],
    ['jobs', workflow.jobs.length > 0 ? workflow.jobs.map((job) => job.name).join(' → ') : 'none declared'],
    [
      'artifacts',
      workflow.artifacts.length > 0 ? workflow.artifacts.map((entry) => entry.path).join(', ') : 'none declared',
    ],
    ['runners', workflow.runners === undefined ? 'any runner' : workflow.runners.join(', ') || 'none in common'],
    ['file', workflow.relativePath],
  ];
  return (
    <dl data-testid={`catalog-detail-${workflow.name}`} className="flex flex-col gap-1 pt-1 text-[9px]">
      {rows.map(([label, value]) => (
        <div key={label} className="flex gap-2">
          <dt className="w-16 shrink-0 text-doom-faint">{label}</dt>
          <dd className="min-w-0 break-words text-doom-dim">{value}</dd>
        </div>
      ))}
    </dl>
  );
}

function WorkflowRow({
  workflow,
  selected,
  inspected,
  onSelect,
  onLaunch,
  onInspect,
}: {
  workflow: WorkflowCatalogEntryView;
  selected: boolean;
  inspected: boolean;
  onSelect: () => void;
  onLaunch: () => void;
  onInspect: () => void;
}) {
  const jobs = workflow.jobs.length;
  // A div rather than a button: the selected row carries buttons of its own.
  return (
    <div
      role="option"
      aria-selected={selected}
      tabIndex={-1}
      data-testid={`catalog-workflow-${workflow.name}`}
      data-selected={selected}
      onClick={onSelect}
      onDoubleClick={onLaunch}
      className={`flex cursor-pointer flex-col gap-1 border-l-2 px-4 py-2 ${
        selected ? 'border-doom-blue bg-doom-panel' : 'border-transparent hover:bg-doom-panel/60'
      }`}
    >
      <div className="flex min-w-0 items-center gap-2">
        <span className="truncate text-[12px] font-bold text-doom-hi">{workflow.name}</span>
        {workflow.tags.map((tag) => (
          <Badge key={tag} size="xs" className="shrink-0">
            {tag}
          </Badge>
        ))}
        <span className="min-w-0 flex-1" />
        <span className={`shrink-0 text-[9px] ${workflow.error === undefined ? 'text-doom-cyan' : 'text-doom-red'}`}>
          {workflow.error === undefined ? `${jobs} job${jobs === 1 ? '' : 's'}` : 'unreadable'}
        </span>
      </div>
      <span className="truncate text-[10px] text-doom-dim">{workflow.description || workflow.relativePath}</span>
      {workflow.error === undefined ? (
        <span className="truncate text-[9px] text-doom-faint">
          {workflow.inputs.length} input{workflow.inputs.length === 1 ? '' : 's'} ·{' '}
          {workflow.runners === undefined ? 'any runner' : workflow.runners.join(', ') || 'no runner in common'}
          {workflow.artifacts.length > 0 ? ` · ${workflow.artifacts.length} artifacts` : ''}
        </span>
      ) : (
        <span className="truncate text-[9px] text-doom-red">{workflow.error}</span>
      )}
      {selected ? (
        <div className="flex items-center gap-3 pt-0.5">
          <Button
            variant="link"
            size="xs"
            data-testid={`catalog-launch-${workflow.name}`}
            className="px-0"
            disabled={workflow.error !== undefined}
            onClick={(event) => {
              event.stopPropagation();
              onLaunch();
            }}
          >
            launch <Kbd>↵</Kbd>
          </Button>
          <Button
            variant="link"
            size="xs"
            data-testid={`catalog-inspect-${workflow.name}`}
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
      {selected && inspected ? <Detail workflow={workflow} /> : null}
    </div>
  );
}

/**
 * The workflow catalog, in the workflows tab's drawer: every workflow the
 * session's directory declares, with a filter and the keys the TUI catalog
 * also answers to. Launching hands the chosen workflow to the dialog.
 */
export function WorkflowCatalogDrawer({
  sessionId,
  onClose,
  onLaunch,
}: {
  sessionId: string;
  onClose: () => void;
  onLaunch: (workflow: WorkflowCatalogEntryView) => void;
}) {
  const state = useStore(catalog.store, (current) => catalog.select(current, sessionId));
  const shown = filterCatalog(state.workflows, state.filter);
  const selected = shown.find((workflow) => workflow.path === state.selected) ?? shown[0];

  const move = (delta: number): void => {
    if (shown.length === 0) return;
    const index = selected === undefined ? -1 : shown.findIndex((workflow) => workflow.path === selected.path);
    const next = shown[(index + delta + shown.length) % shown.length];
    if (next) selectWorkflow(sessionId, next.path);
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
      if (selected.error === undefined) onLaunch(selected);
      return;
    }
    if (typing) return;
    if (event.key === 'i') toggleInspect(sessionId, selected.path);
  };

  return (
    <aside
      data-testid="workflow-catalog-drawer"
      tabIndex={0}
      onKeyDown={onKeyDown}
      className="flex w-[min(440px,calc(100vw-24px))] shrink-0 flex-col overflow-hidden border-l border-doom-border bg-doom-rail outline-none"
    >
      <div className="flex h-11 shrink-0 items-center gap-2.5 border-b border-doom-border px-4">
        <span className="text-[13px] font-bold text-doom-hi">workflow catalog</span>
        <Badge size="xs" data-testid="catalog-count">
          {state.workflows.length} workflow{state.workflows.length === 1 ? '' : 's'}
        </Badge>
        <span className="min-w-0 flex-1" />
        <Kbd>SPC w l</Kbd>
        <Button variant="ghost" size="icon" data-testid="catalog-close" title="close the catalog" onClick={onClose}>
          <CloseIcon className="h-3 w-3" />
        </Button>
      </div>
      <div className="px-4 pt-2.5 pb-1.5">
        <Input
          data-testid="catalog-filter"
          value={state.filter}
          placeholder="filter by name, tag, or job…"
          autoFocus
          onChange={(event) => setCatalogFilter(sessionId, event.target.value)}
        />
      </div>
      <div role="listbox" className="flex min-h-0 flex-1 flex-col overflow-y-auto pb-2">
        {shown.length === 0 ? (
          <p data-testid="catalog-empty" className="px-4 py-3 text-[10px] text-doom-faint">
            {state.warning ??
              (state.workflows.length === 0
                ? 'no workflows found for this session; add one under automations/workflows'
                : 'nothing matches the filter')}
          </p>
        ) : null}
        {shown.map((workflow) => (
          <WorkflowRow
            key={workflow.path}
            workflow={workflow}
            selected={selected?.path === workflow.path}
            inspected={state.inspected === workflow.path}
            onSelect={() => selectWorkflow(sessionId, workflow.path)}
            onLaunch={() => onLaunch(workflow)}
            onInspect={() => toggleInspect(sessionId, workflow.path)}
          />
        ))}
      </div>
      <div className="flex h-8 shrink-0 items-center justify-between border-t border-doom-border-soft bg-doom-deep px-4">
        <span className="text-[9px] text-doom-faint">↑↓ choose · enter launch · i inspect · esc close</span>
        <span className="text-[9px] text-doom-faint">{state.cwd}</span>
      </div>
    </aside>
  );
}
