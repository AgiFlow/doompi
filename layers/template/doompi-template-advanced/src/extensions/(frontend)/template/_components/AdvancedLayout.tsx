import type { WebTemplateProps } from '@agimon-ai/doompi-core/web';
import { Button, Drawer } from '@agimon-ai/doompi-web-components';

import { useWideLayout } from '../_lib/useWideLayout';

/** The full cockpit frame. Session behavior and extension content stay in the host slots. */
export function AdvancedLayout({
  slots,
  navigationOpen,
  desktopActivityOpen,
  mobileActivityOpen,
  onNavigationOpenChange,
  onDesktopActivityOpenChange,
  onMobileActivityOpenChange,
}: WebTemplateProps) {
  const railVisible = useWideLayout('(min-width: 768px)');
  const dockVisible = useWideLayout('(min-width: 1024px)');
  return (
    <div className="relative flex h-full min-w-0 overflow-hidden">
      {railVisible ? (
        <aside
          data-testid="session-rail-panel"
          className="flex w-[300px] shrink-0 flex-col overflow-y-auto border-r border-doom-border bg-doom-rail"
        >
          {slots.navigation}
        </aside>
      ) : (
        <Drawer
          open={navigationOpen}
          onOpenChange={onNavigationOpenChange}
          side="left"
          title="Sessions"
          showHeader={false}
          data-testid="session-rail-panel"
          backdropTestId="mobile-drawer-backdrop"
        >
          {slots.navigation}
        </Drawer>
      )}
      <main className="flex min-w-0 flex-1 flex-col overflow-hidden">
        {slots.notices}
        {slots.header({ navigationToggle: 'mobile', activityToggle: 'mobile' })}
        {slots.content}
        {slots.composer}
        {slots.controls}
      </main>
      {slots.activity == null ? null : dockVisible ? (
        desktopActivityOpen ? (
          <div className="flex">{slots.activity}</div>
        ) : (
          <Button
            variant="ghost"
            data-testid="activity-show"
            title="show the activity dock"
            onClick={() => onDesktopActivityOpenChange(true)}
            className="h-auto shrink-0 rounded-none border-l border-doom-border bg-doom-rail px-2 py-3 text-2xs tracking-widest text-doom-dim hover:bg-doom-rail"
            style={{ writingMode: 'vertical-rl' }}
          >
            ACTIVITY
          </Button>
        )
      ) : (
        <Drawer
          open={mobileActivityOpen}
          onOpenChange={onMobileActivityOpenChange}
          side="right"
          title="Activity"
          showHeader={false}
          backdropTestId="mobile-activity-backdrop"
          className="w-auto max-w-[calc(100vw-48px)]"
        >
          {slots.activity}
        </Drawer>
      )}
    </div>
  );
}
