import type { WebTemplateProps } from '@agimon-ai/doompi-core/web';
import { Drawer } from '@agimon-ai/doompi-web-components';

/** A conversation-first frame, with the same host capabilities available on demand. */
export function ElegantLayout({
  view,
  slots,
  navigationOpen,
  mobileActivityOpen,
  onNavigationOpenChange,
  onMobileActivityOpenChange,
}: WebTemplateProps) {
  const conversation = view === 'conversation' || view === 'welcome';
  return (
    <div className="relative flex h-full min-w-0 flex-col overflow-hidden bg-doom-bg">
      <Drawer
        open={navigationOpen}
        onOpenChange={onNavigationOpenChange}
        side="left"
        title="Sessions"
        data-testid="session-rail-panel"
        backdropTestId="mobile-drawer-backdrop"
      >
        {slots.navigation}
      </Drawer>
      {slots.notices}
      {slots.header({ navigationToggle: 'always', activityToggle: 'always' })}
      <main className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden">
        <div
          data-testid="template-content"
          className={
            conversation
              ? 'mx-auto flex min-h-0 w-full max-w-[960px] flex-1 flex-col overflow-hidden px-2 sm:px-6'
              : 'flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden'
          }
        >
          {slots.content}
          {slots.composer == null ? null : (
            <div className="mx-2 mb-3 shrink-0 overflow-hidden rounded-lg border border-doom-border bg-doom-panel sm:mx-4 sm:mb-5">
              {slots.composer}
            </div>
          )}
          {slots.controls == null ? null : (
            <details className="shrink-0 px-3 pb-3 text-sm text-doom-dim">
              <summary
                data-testid="template-controls-toggle"
                className="cursor-pointer rounded-sm px-1 py-1 focus-visible:outline focus-visible:outline-doom-blue"
              >
                Session controls
              </summary>
              {slots.controls}
            </details>
          )}
        </div>
      </main>
      {slots.activity == null ? null : (
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
