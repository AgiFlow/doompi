import type { WebTemplateProps } from '@agimon-ai/doompi-core/web';
import { Button } from '@agimon-ai/doompi-web-components';

/** The current full cockpit frame, with each stateful host slot mounted only once. */
export function AdvancedLayout({
  slots,
  navigationOpen,
  desktopActivityOpen,
  mobileActivityOpen,
  onNavigationOpenChange,
  onDesktopActivityOpenChange,
  onMobileActivityOpenChange,
}: WebTemplateProps) {
  const activityDockClass = mobileActivityOpen
    ? desktopActivityOpen
      ? 'fixed inset-y-0 right-0 z-40 flex lg:static lg:z-auto'
      : 'fixed inset-y-0 right-0 z-40 flex lg:hidden'
    : desktopActivityOpen
      ? 'hidden lg:flex'
      : 'hidden';

  return (
    <div className="relative flex h-full min-w-0 overflow-hidden">
      <aside
        data-testid="session-rail-panel"
        className={`fixed inset-y-0 left-0 z-40 flex w-[min(300px,calc(100vw-48px))] shrink-0 flex-col overflow-y-auto border-r border-doom-border bg-doom-rail transition-transform md:visible md:static md:z-auto md:w-[300px] md:translate-x-0 ${navigationOpen ? 'visible translate-x-0' : 'invisible -translate-x-full'}`}
      >
        {slots.navigation}
      </aside>
      {navigationOpen ? (
        <Button
          variant="ghost"
          data-testid="mobile-drawer-backdrop"
          aria-label="hide sessions"
          className="fixed inset-0 z-30 h-auto w-auto rounded-none bg-black/55 p-0 hover:bg-black/55 md:hidden"
          onClick={() => onNavigationOpenChange(false)}
        />
      ) : null}
      <main className="flex min-w-0 flex-1 flex-col overflow-hidden">
        {slots.notices}
        {slots.header({ navigationToggle: 'mobile', activityToggle: 'mobile' })}
        {slots.content}
        {slots.composer}
        {slots.controls}
      </main>
      {slots.activity == null ? null : desktopActivityOpen || mobileActivityOpen ? (
        <div className={activityDockClass}>{slots.activity}</div>
      ) : (
        <Button
          variant="ghost"
          data-testid="activity-show"
          title="show the activity dock"
          onClick={() => onDesktopActivityOpenChange(true)}
          className="hidden h-auto shrink-0 rounded-none border-l border-doom-border bg-doom-rail px-2 py-3 text-2xs tracking-widest text-doom-dim hover:bg-doom-rail lg:flex"
          style={{ writingMode: 'vertical-rl' }}
        >
          ACTIVITY
        </Button>
      )}
      {mobileActivityOpen ? (
        <Button
          variant="ghost"
          data-testid="mobile-activity-backdrop"
          aria-label="hide activity"
          className="fixed inset-0 z-30 h-auto w-auto rounded-none bg-black/55 p-0 hover:bg-black/55 lg:hidden"
          onClick={() => onMobileActivityOpenChange(false)}
        />
      ) : null}
    </div>
  );
}
