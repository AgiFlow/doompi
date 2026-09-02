import type { ContextItemKind } from '@agimon-ai/doompi/contextApi';
import { Button, EmptyState } from '@agimon-ai/doompi-web-components';
import { useState } from 'react';
import {
  type ContextGroup,
  type ContextItemSource,
  contextGroups,
  inactiveTotal,
  ownerLabel,
  ownersOf,
  projectedGroups,
  totalTokens,
} from '../../lib/contextComposition.ts';
import { useActiveSessionMeta } from '../../stores/sessionsStore.ts';
import { useActiveSession } from '../../stores/sessionStore.ts';
import { ContextItemDialog } from './ContextItemDialog.tsx';

/** The row a reader clicked, which is all the detail request is made of. */
interface ItemTarget {
  itemKind: ContextItemKind;
  name: string;
  owner: string;
}

/** Short enough to sit in a fixed column without wrapping the tool's own name. */
const SOURCE_LABEL: Record<ContextItemSource, string> = {
  extension: 'ext',
  mcp: 'mcp',
  plugin: 'plug',
  core: 'core',
};

/** The tilde is the whole caveat in one character: this is arithmetic, not a bill. */
function tokens(value: number | null): string {
  return value === null ? '—' : `~${value.toLocaleString()}`;
}

/**
 * What the session is carrying.
 *
 * Every tool and skill in here is spending context before the first message,
 * so the surface is built around the one question worth asking of it: what is
 * this costing, and what do I switch off to stop paying it. Modes head the
 * groups because a mode is what you switch; packages head the rows inside them
 * because a package is what you add or remove. It reads only; switching stays
 * with the composer chips that already own it.
 */
export function ContextPanel() {
  const statuses = useActiveSession((state) => state.statuses);
  const widgets = useActiveSession((state) => state.widgets);
  const projection = useActiveSession((state) => state.minorModes);
  const context = useActiveSession((state) => state.context);
  const sessionId = useActiveSessionMeta()?.summary.id ?? null;
  const [target, setTarget] = useState<ItemTarget | null>(null);
  // The runtime's grouping wins once it arrives; the status line only has to
  // carry the surface until the session has reported its inventory.
  const groups = context ? projectedGroups(context) : contextGroups(statuses, widgets, projection);
  const total = totalTokens(groups);
  const idle = inactiveTotal(groups);

  return (
    <div data-testid="context-panel" className="flex min-h-0 flex-1 flex-col">
      <div data-testid="context-scroll" className="min-h-0 flex-1 overflow-y-auto">
        {groups.length === 0 ? (
          <EmptyState
            data-testid="context-empty"
            className="px-4 py-5"
            title="no composition yet"
            description="the session reports its major mode, minor modes, and domains once it has started."
          />
        ) : (
          <div className="flex flex-col">
            {groups.map((group) => (
              <ContextGroupView key={`${group.kind}:${group.id}`} group={group} onSelect={setTarget} />
            ))}
          </div>
        )}
      </div>

      <div className="shrink-0 border-t border-doom-border px-4 py-3">
        <div className="flex items-center justify-between">
          <span className="text-[10px] font-bold text-doom-text">active</span>
          <span data-testid="context-total" className="text-[10px] font-bold text-doom-text">
            {tokens(total)}
          </span>
        </div>
        {idle > 0 ? (
          <div className="flex items-center justify-between">
            <span className="text-[10px] text-doom-faint">inactive</span>
            <span data-testid="context-inactive" className="text-[10px] text-doom-faint">
              {`+${tokens(idle)}`}
            </span>
          </div>
        ) : null}
        <span className="text-[9px] leading-relaxed text-doom-faint">
          {`estimated · ${context?.estimator ?? 'gpt-tokenizer'} BPE · not a billed total`}
        </span>
      </div>

      <ContextItemDialog sessionId={sessionId} target={target} onClose={() => setTarget(null)} />
    </div>
  );
}

function ContextGroupView({ group, onSelect }: { group: ContextGroup; onSelect: (target: ItemTarget) => void }) {
  return (
    <div
      data-testid={`context-group-${group.id}`}
      data-kind={group.kind}
      className="flex flex-col gap-1 border-b border-doom-border-soft px-3 py-3"
    >
      {/* The same head the activity dock uses, for the same reason: the glyph
          says "section", so a mode never reads as one more row among the tools
          it brought with it. */}
      <div className="flex items-center gap-2 px-1">
        <span aria-hidden className="text-[11px] font-bold text-doom-faint">
          #
        </span>
        <span className="flex-1 text-[11px] font-bold text-doom-text">{group.label}</span>
        <span className="text-[8px] font-bold tracking-widest text-doom-violet uppercase">{group.kind}</span>
        <span data-testid={`context-subtotal-${group.id}`} className="w-14 text-right text-[10px] text-doom-dim">
          {tokens(group.tokens)}
        </span>
      </div>

      {group.items.length === 0 ? (
        <p data-testid={`context-pending-${group.id}`} className="px-1 text-[10px] text-doom-faint">
          {group.detail || 'no tools or skills reported'}
        </p>
      ) : (
        ownersOf(group).map((owner) => (
          <div key={owner.owner} className="flex flex-col">
            {/* The package heads its own rows, so the source tag sits here
                rather than repeating on every tool that shares it. */}
            <div
              data-testid={`context-owner-${owner.owner}`}
              title={owner.owner}
              className="flex items-center gap-2 px-1 pt-1"
            >
              <span className="flex-1 truncate text-[10px] text-doom-dim">{ownerLabel(owner.owner)}</span>
              <span className="text-[9px] text-doom-faint">{SOURCE_LABEL[owner.source]}</span>
              <span className="w-14 text-right text-[10px] text-doom-dim">{tokens(owner.tokens)}</span>
            </div>
            {owner.items.map((item) => (
              // A row is a question as much as a figure: what am I paying for.
              // The answer is too large to have travelled with the panel, so
              // the row asks for it rather than carrying it.
              <Button
                variant="ghost"
                size="card"
                key={`${item.itemKind}:${item.name}`}
                data-testid={`context-row-${item.name}`}
                data-active={item.active}
                onClick={() => onSelect({ itemKind: item.itemKind, name: item.name, owner: item.owner })}
                className="flex-row items-center gap-2 rounded-none py-px pr-1 pl-4"
              >
                <span className={`flex-1 truncate text-[10px] ${item.active ? 'text-doom-text' : 'text-doom-faint'}`}>
                  {item.name}
                </span>
                <span
                  title={item.active ? undefined : 'not sent to the model; costs nothing until switched on'}
                  className={`w-14 text-right text-[10px] ${item.active ? 'text-doom-dim' : 'text-doom-faint'}`}
                >
                  {item.active ? tokens(item.tokens) : `(${tokens(item.tokens)})`}
                </span>
              </Button>
            ))}
          </div>
        ))
      )}
    </div>
  );
}
