import { Button, EmptyState, Kbd, StatusBadge } from '@agimon-ai/doompi-web-components';
import { useStore } from '@tanstack/react-store';
import { useEffect, useRef } from 'react';
import { PluginSurface } from '../../components/PluginSurface.tsx';
import { type ActivityGroup, useActivityGroups, useDockFaces } from '../../lib/composition.ts';
import { activityGroupSlot, HOST_SLOTS, slotFills } from '../../lib/pluginRegistry.ts';
import { usePluginSlotProps } from '../../stores/usePluginSlotProps.ts';
import { useActiveSession } from '../../stores/sessionStore.ts';
import { sessionsStore } from '../../stores/sessionsStore.ts';
import { setDockTab, uiStore } from '../../stores/uiStore.ts';
import { ContextPanel } from './ContextPanel.tsx';
import { DockTabs } from './DockTabs.tsx';

/**
 * The column for everything that is not the transcript.
 *
 * It has two faces. `activity` is asynchronous work that outlives the turn that
 * started it: agents, runners, and workflows deliberately live outside the
 * transcript, so they get a surface that does not scroll away. `context` is the
 * composition that work runs under, and what carrying it costs.
 *
 * On the activity face the host owns only the frame: which groups exist, their
 * key chips, and what they render come from the packages that declare them.
 * Each declared group opens the keyed slot activity.<name>; the sections any
 * plugin registers under that name render there, in slot order, and a group
 * nobody fills shows the one-line summary the session's footer publishes.
 */
export function ActivityDock({ onClose, onOpenContent }: { onClose: () => void; onOpenContent: () => void }) {
  const activeId = useStore(sessionsStore, (state) => state.activeId);
  const statuses = useActiveSession((state) => state.statuses);
  const widgets = useActiveSession((state) => state.widgets);
  const slotProps = usePluginSlotProps(activeId, onOpenContent);
  const tab = useStore(uiStore, (state) => state.dockTab);
  const dockFaces = useDockFaces(activeId).filter(
    (face) => face.requiredMinorMode === undefined || slotProps.activeMinorModes?.includes(face.requiredMinorMode),
  );
  const selectedFace = dockFaces.find((face) => face.id === tab);
  const resolvedTab = tab === 'context' || tab === 'activity' || selectedFace !== undefined ? tab : 'activity';
  const DockPanel = selectedFace?.panel;
  const automaticFace = dockFaces.find((face) => face.autoSelect === true);
  const automaticFaceKey = `${activeId ?? ''}:${automaticFace?.id ?? ''}`;
  const lastAutomaticFaceKey = useRef<string | undefined>(undefined);
  const groups = useActivityGroups(statuses, widgets, activeId);
  const ordinaryGroups = groups.filter((group) => group.placement !== 'bottom');
  const pinnedGroups = groups.filter((group) => group.placement === 'bottom');
  const busy = groups.filter((group) => group.active).length;

  useEffect(() => {
    if (lastAutomaticFaceKey.current === automaticFaceKey) return;
    lastAutomaticFaceKey.current = automaticFaceKey;
    if (automaticFace !== undefined) setDockTab(automaticFace.id);
  }, [automaticFace, automaticFaceKey]);
  useEffect(() => {
    if (resolvedTab !== tab) setDockTab(resolvedTab);
  }, [resolvedTab, tab]);
  return (
    <aside
      data-testid="activity-dock"
      className="flex w-[min(300px,calc(100vw-48px))] shrink-0 flex-col overflow-hidden border-l border-doom-border bg-doom-rail sm:w-[300px]"
    >
      <div className="flex h-12 shrink-0 items-center justify-between border-b border-doom-border px-4">
        <div className="flex items-center gap-2">
          <DockTabs contributed={dockFaces} />
          {/* The count belongs to the activity face; on the context face it
              would be a number about a list the reader is not looking at. */}
          {busy > 0 && resolvedTab === 'activity' ? (
            <StatusBadge tone="running" size="xs" data-testid="activity-busy" className="normal-case">
              {busy} running
            </StatusBadge>
          ) : null}
        </div>
        <Button variant="ghost" size="xs" data-testid="activity-close" onClick={onClose} className="text-[10px]">
          hide
        </Button>
      </div>

      {DockPanel !== undefined ? (
        <DockPanel {...slotProps} />
      ) : resolvedTab === 'context' ? (
        <ContextPanel />
      ) : (
        <>
          <div data-testid="activity-scroll" className="min-h-0 flex-1 overflow-y-auto">
            {groups.length === 0 ? (
              <EmptyState
                data-testid="activity-empty"
                className="px-4 py-5"
                title="nothing supervised yet"
                description="a package's group appears here once its extension reports in."
              />
            ) : null}
            {ordinaryGroups.length > 0 ? (
              <div className="flex flex-col">
                {ordinaryGroups.map((group) => (
                  <ActivityGroupView key={group.name} group={group} slotProps={slotProps} />
                ))}
              </div>
            ) : null}

            <PluginSurface slot={HOST_SLOTS.activity} sessionId={activeId} />
          </div>

          {pinnedGroups.length > 0 ? (
            <div data-testid="activity-pinned" className="shrink-0">
              {pinnedGroups.map((group) => (
                <ActivityGroupView key={group.name} group={group} slotProps={slotProps} />
              ))}
            </div>
          ) : null}

          <div className="border-t border-doom-border px-4 py-3">
            <span className="text-[9px] leading-relaxed text-doom-faint">
              each group is rendered by the package that owns it; the session's summary line stands in until that
              package publishes per-run detail
            </span>
          </div>
        </>
      )}
    </aside>
  );
}

function ActivityGroupView({
  group,
  slotProps,
}: {
  group: ActivityGroup;
  slotProps: ReturnType<typeof usePluginSlotProps>;
}) {
  return (
    <div
      data-testid={`activity-${group.name}`}
      data-active={group.active}
      className="flex flex-col gap-2 border-b border-doom-border-soft px-3 py-3"
    >
      <div className="flex items-center gap-2 px-1">
        {/* One marker per head. The glyph says "section", so a group
            never reads as one more row among the items beneath it,
            and it carries the busy colour the status dot used to:
            two marks for one fact is one mark too many. A glyph
            rather than an icon because every group is declared by a
            plugin the host knows nothing about. */}
        <span
          aria-hidden
          data-active={group.active}
          className={`text-[11px] font-bold ${group.active ? 'animate-pulse text-doom-yellow' : 'text-doom-faint'}`}
        >
          #
        </span>
        {/* A group that owns a panel opens it from its own name: the tab is
            temporary, so the tab strip carries it only while the reader is
            using it. Groups without a panel keep the name as a plain label. */}
        {group.transientTab === undefined ? (
          <span className="flex-1 text-[11px] font-bold text-doom-text">{group.name}</span>
        ) : (
          <Button
            variant="ghost"
            size="xs"
            data-testid={`activity-open-${group.name}`}
            title={`open ${group.name}`}
            onClick={() => {
              const tab = group.transientTab?.();
              if (tab !== undefined) slotProps.openTransientTab(tab);
            }}
            className="h-auto flex-1 justify-start px-0 py-0 text-[11px] font-bold text-doom-text hover:underline"
          >
            {group.name}
          </Button>
        )}
        <Kbd data-testid={`activity-keys-${group.name}`} className="bg-doom-panel">
          {group.keys}
        </Kbd>
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
  );
}
