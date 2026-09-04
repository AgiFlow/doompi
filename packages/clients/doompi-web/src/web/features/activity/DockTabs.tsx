import { Button, SectionLabel } from '@agimon-ai/doompi-web-components';
import { useStore } from '@tanstack/react-store';
import { useDockFaces } from '../../lib/composition.ts';
import { type DockTab, setDockTab, uiStore } from '../../stores/uiStore.ts';

const HOST_TABS: readonly { id: DockTab; label: string }[] = [
  { id: 'activity', label: 'activity' },
  { id: 'context', label: 'context' },
];

/** Host faces followed by the active session's plugin-contributed faces. */
export function DockTabs() {
  const active = useStore(uiStore, (state) => state.dockTab);
  const contributed = useDockFaces();
  const tabs = [...HOST_TABS, ...contributed.map(({ id, label }) => ({ id, label }))];

  return (
    <div className="flex items-center gap-3" role="tablist" aria-label="dock view">
      {tabs.map((tab) => (
        <Button
          key={tab.id}
          variant="ghost"
          size="xs"
          role="tab"
          aria-selected={tab.id === active}
          data-testid={`dock-tab-${tab.id}`}
          data-active={tab.id === active}
          onClick={() => setDockTab(tab.id)}
          className="h-auto rounded-none px-0 py-0 hover:bg-transparent"
        >
          <SectionLabel className={tab.id === active ? 'text-doom-hi' : 'text-doom-faint hover:text-doom-dim'}>
            {tab.label}
          </SectionLabel>
        </Button>
      ))}
    </div>
  );
}
