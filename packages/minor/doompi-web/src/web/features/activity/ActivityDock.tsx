import { useStore } from '@tanstack/react-store';
import { Dot } from '../../components/Chip.tsx';
import { PluginSurface } from '../../components/PluginSurface.tsx';
import { activityGroups } from '../../lib/composition.ts';
import { pluginActivityGroups, surfaceContributions } from '../../lib/pluginRegistry.ts';
import { useOpenTab } from '../../stores/useOpenTab.ts';
import { runCommand, useActiveSession } from '../../stores/sessionStore.ts';
import { sessionsStore } from '../../stores/sessionsStore.ts';

/**
 * Asynchronous work that outlives the turn that started it.
 *
 * Agents, runners, and workflows deliberately live outside the transcript, so
 * they get a surface that does not scroll away. Each group renders what its
 * extension publishes to the footer: a summary while something is running,
 * nothing when it is idle. A plugin that knows more than the footer line
 * claims its group with an activity section of the same name, which then
 * renders in place of the summary.
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
          this composition loads no agent, runner, or workflow packages, so there is nothing to supervise here.
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
                <button
                  type="button"
                  data-testid={`activity-open-${group.name}`}
                  onClick={() => runCommand(group.name === 'runners' ? 'runners' : group.name)}
                  className="rounded bg-doom-panel px-1.5 py-0.5 text-[8px] font-bold text-doom-violet hover:text-doom-magenta"
                >
                  {group.keys}
                </button>
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
          a group shows the session's summary line unless its plugin publishes per-run detail
        </span>
      </div>
    </aside>
  );
}
