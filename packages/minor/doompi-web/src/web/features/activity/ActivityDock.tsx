import { useStore } from '@tanstack/react-store';
import { Dot } from '../../components/Chip.tsx';
import { PluginSurface } from '../../components/PluginSurface.tsx';
import { activityGroups } from '../../lib/composition.ts';
import { pluginActivityGroups, surfaceContributions } from '../../lib/pluginRegistry.ts';
import { useOpenTab } from '../../stores/useOpenTab.ts';
import { useActiveSession } from '../../stores/sessionStore.ts';
import { sessionsStore } from '../../stores/sessionsStore.ts';

/**
 * Asynchronous work that outlives the turn that started it.
 *
 * Agents, runners, and workflows deliberately live outside the transcript, so
 * they get a surface that does not scroll away. The host owns only the frame:
 * which groups exist, their key chips, and what they render come from the
 * packages that declare them. A group whose plugin registers an activity
 * section of the same name renders that section; otherwise the body is the
 * one-line summary the session's footer publishes.
 */
export function ActivityDock({ onClose }: { onClose: () => void }) {
  const activeId = useStore(sessionsStore, (state) => state.activeId);
  const statuses = useActiveSession((state) => state.statuses);
  const widgets = useActiveSession((state) => state.widgets);
  const openTab = useOpenTab();
  const groups = activityGroups(statuses, widgets);
  const busy = groups.filter((group) => group.active).length;
  const sections = new Map(surfaceContributions('activity').map((section) => [section.id, section]));
  // A section named after a declared group belongs inside it, whether or not
  // the session is publishing that group right now.
  const claimed = new Set(pluginActivityGroups().map((group) => group.name));

  return (
    <aside
      data-testid="activity-dock"
      className="flex w-[300px] shrink-0 flex-col border-l border-doom-border bg-doom-rail"
    >
      <div className="flex h-13 shrink-0 items-center justify-between border-b border-doom-border px-4">
        <div className="flex items-center gap-2">
          <span className="text-[9px] font-bold tracking-[0.16em] text-doom-hi">ACTIVITY</span>
          {busy > 0 ? (
            <span
              data-testid="activity-busy"
              className="rounded bg-doom-yellow/15 px-1.5 py-0.5 text-[8px] font-bold text-doom-yellow"
            >
              {busy} running
            </span>
          ) : null}
        </div>
        <button
          type="button"
          data-testid="activity-close"
          onClick={onClose}
          className="text-[10px] text-doom-dim hover:text-doom-hi"
        >
          hide
        </button>
      </div>

      {groups.length === 0 ? (
        <p data-testid="activity-empty" className="px-4 py-5 text-[11px] leading-relaxed text-doom-faint">
          nothing is supervised in this session yet. a package's group appears here once its extension reports in.
        </p>
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
                <Dot tone={group.active ? 'yellow' : 'neutral'} />
                <span className="flex-1 text-[11px] font-bold text-doom-text">{group.name}</span>
                {group.tab === undefined ? (
                  <span
                    data-testid={`activity-keys-${group.name}`}
                    className="rounded bg-doom-panel px-1.5 py-0.5 text-[8px] font-bold text-doom-faint"
                  >
                    {group.keys}
                  </span>
                ) : (
                  <button
                    type="button"
                    data-testid={`activity-open-${group.name}`}
                    title={`open the ${group.tab} tab`}
                    onClick={() => openTab(group.tab ?? null)}
                    className="rounded bg-doom-panel px-1.5 py-0.5 text-[8px] font-bold text-doom-violet hover:text-doom-magenta"
                  >
                    {group.keys}
                  </button>
                )}
              </div>
              {(() => {
                const Section = sections.get(group.name)?.component;
                return Section ? (
                  <Section sessionId={activeId} openTab={openTab} />
                ) : (
                  <p
                    data-testid={`activity-summary-${group.name}`}
                    className={`px-1 text-[10px] ${group.active ? 'text-doom-yellow' : 'text-doom-faint'}`}
                  >
                    {group.summary || 'idle'}
                  </p>
                );
              })()}
            </div>
          ))}
        </div>
      )}

      <PluginSurface slot="activity" sessionId={activeId} except={claimed} />

      <div className="mt-auto border-t border-doom-border px-4 py-3">
        <span className="text-[9px] leading-relaxed text-doom-faint">
          each group is rendered by the package that owns it; the session's summary line stands in until that package
          publishes per-run detail
        </span>
      </div>
    </aside>
  );
}
