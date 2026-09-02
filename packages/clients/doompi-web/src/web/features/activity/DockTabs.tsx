import { Button, SectionLabel } from '@agimon-ai/doompi-web-components';
import { useStore } from '@tanstack/react-store';
import { type DockTab, setDockTab, uiStore } from '../../stores/uiStore.ts';

const TABS: readonly DockTab[] = ['activity', 'context'];

/**
 * The dock's two faces.
 *
 * These read as section headings rather than as a control strip, because the
 * dock has always been headed by one tracked-out label and the eye already
 * looks there for "what am I seeing". The selected face keeps the bright
 * colour the single label used to carry, so nothing new has to be learned.
 */
export function DockTabs() {
  const active = useStore(uiStore, (state) => state.dockTab);

  return (
    <div className="flex items-center gap-3" role="tablist" aria-label="dock view">
      {TABS.map((tab) => (
        <Button
          key={tab}
          variant="ghost"
          size="xs"
          role="tab"
          aria-selected={tab === active}
          data-testid={`dock-tab-${tab}`}
          data-active={tab === active}
          onClick={() => setDockTab(tab)}
          className="h-auto rounded-none px-0 py-0 hover:bg-transparent"
        >
          <SectionLabel className={tab === active ? 'text-doom-hi' : 'text-doom-faint hover:text-doom-dim'}>
            {tab}
          </SectionLabel>
        </Button>
      ))}
    </div>
  );
}
