import { Button, Dot, EmptyState, Kbd, SectionLabel, StatusBadge } from '@agimon-ai/doompi-web-components';
import { useStore } from '@tanstack/react-store';
import { PluginSurface } from '../../components/PluginSurface.tsx';
import { activityGroups } from '../../lib/composition.ts';
import { activityGroupSlot, HOST_SLOTS, slotFills } from '../../lib/pluginRegistry.ts';
import { usePluginSlotProps } from '../../stores/usePluginSlotProps.ts';
import { useActiveSession } from '../../stores/sessionStore.ts';
import { sessionsStore } from '../../stores/sessionsStore.ts';

/**
 * Asynchronous work that outlives the turn that started it.
 *
 * Agents, runners, and workflows deliberately live outside the transcript, so
 * they get a surface that does not scroll away. The host owns only the frame:
 * which groups exist, their key chips, and what they render come from the
 * packages that declare them. Each declared group opens the keyed slot
 * activity.<name>; the sections any plugin registers under that name render
 * there, in slot order, and a group nobody fills shows the one-line summary
 * the session's footer publishes.
 */
export function ActivityDock({ onClose }: { onClose: () => void }) {
  const activeId = useStore(sessionsStore, (state) => state.activeId);
  const statuses = useActiveSession((state) => state.statuses);
  const widgets = useActiveSession((state) => state.widgets);
  const slotProps = usePluginSlotProps(activeId);
  const groups = activityGroups(statuses, widgets);
  const busy = groups.filter((group) => group.active).length;

  return (
    <aside
      data-testid="activity-dock"
      className="flex w-[300px] shrink-0 flex-col overflow-hidden border-l border-doom-border bg-doom-rail"
    >
      <div className="flex h-12 shrink-0 items-center justify-between border-b border-doom-border px-4">
        <div className="flex items-center gap-2">
          <SectionLabel className="text-doom-hi">activity</SectionLabel>
          {busy > 0 ? (
            <StatusBadge tone="running" size="xs" data-testid="activity-busy" className="normal-case">
              {busy} running
            </StatusBadge>
          ) : null}
        </div>
        <Button variant="ghost" size="xs" data-testid="activity-close" onClick={onClose} className="text-[10px]">
          hide
        </Button>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto">
        {groups.length === 0 ? (
          <EmptyState
            data-testid="activity-empty"
            className="px-4 py-5"
            title="nothing supervised yet"
            description="a package's group appears here once its extension reports in."
          />
        ) : (
          <div className="flex flex-col">
            {groups.map((group) => (
              <div
                key={group.name}
                data-testid={`activity-${group.name}`}
                data-active={group.active}
                className="flex flex-col gap-2 border-b border-doom-border-soft px-3 py-3"
              >
                <div className="flex items-center gap-2 px-1">
                  <Dot tone={group.active ? 'yellow' : 'neutral'} pulse={group.active} />
                  <span className="flex-1 text-[11px] font-bold text-doom-text">{group.name}</span>
                  {group.tab === undefined ? (
                    <Kbd data-testid={`activity-keys-${group.name}`} className="bg-doom-panel">
                      {group.keys}
                    </Kbd>
                  ) : (
                    <Button
                      variant="subtle"
                      size="xs"
                      data-testid={`activity-open-${group.name}`}
                      title={`open the ${group.tab} tab`}
                      onClick={() => slotProps.openTab(group.tab ?? null)}
                      className="h-auto px-1.5 py-0.5 text-[8px] font-bold text-doom-violet hover:text-doom-magenta"
                    >
                      {group.keys}
                    </Button>
                  )}
                </div>
                {slotFills(activityGroupSlot(group.name)).length > 0 ? (
                  slotProps.renderSlot(activityGroupSlot(group.name))
                ) : (
                  <p
                    data-testid={`activity-summary-${group.name}`}
                    className={`px-1 text-[10px] ${group.active ? 'text-doom-yellow' : 'text-doom-faint'}`}
                  >
                    {group.summary || 'idle'}
                  </p>
                )}
              </div>
            ))}
          </div>
        )}

        <PluginSurface slot={HOST_SLOTS.activity} sessionId={activeId} />
      </div>

      <div className="border-t border-doom-border px-4 py-3">
        <span className="text-[9px] leading-relaxed text-doom-faint">
          each group is rendered by the package that owns it; the session's summary line stands in until that package
          publishes per-run detail
        </span>
      </div>
    </aside>
  );
}
