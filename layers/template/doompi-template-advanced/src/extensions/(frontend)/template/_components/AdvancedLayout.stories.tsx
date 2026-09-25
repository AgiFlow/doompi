import { AdvancedLayout } from './AdvancedLayout';

const slots = {
  navigation: (
    <div className="p-4 text-sm text-doom-text">
      Sessions
      <br />
      Template architecture
      <br />
      Review package contracts
    </div>
  ),
  header: () => (
    <div className="flex h-12 items-center border-b border-doom-border px-5 text-base font-bold text-doom-hi">
      Template architecture
    </div>
  ),
  notices: null,
  content: (
    <div className="flex min-h-0 flex-1 flex-col gap-5 overflow-y-auto p-6 text-sm text-doom-text">
      <div className="rounded-md bg-doom-panel p-4">
        Advanced keeps sessions, conversation, and activity visible together.
      </div>
      <div className="self-end rounded-md bg-doom-tint-blue p-4 text-doom-hi">
        Templates only place host-owned slots.
      </div>
    </div>
  ),
  composer: (
    <div className="border-t border-doom-border p-3">
      <div className="rounded-md border border-doom-border bg-doom-panel px-4 py-3 text-sm text-doom-dim">
        Ask DoomPi anything…
      </div>
    </div>
  ),
  controls: <div className="border-t border-doom-border px-4 py-2 text-xs text-doom-faint">mode · model · context</div>,
  activity: (
    <div className="h-full w-64 border-l border-doom-border bg-doom-rail p-4 text-sm text-doom-text">
      Activity
      <br />3 tasks completed
      <br />
      Context 42%
    </div>
  ),
};

const meta = { title: 'Templates/AdvancedLayout', component: AdvancedLayout, tags: ['style-system'] };
export default meta;

export const Playground = {
  render: () => (
    <div className="h-[720px] w-full max-w-[1180px] bg-doom-bg">
      <AdvancedLayout
        view="conversation"
        slots={slots}
        navigationOpen={false}
        desktopActivityOpen
        mobileActivityOpen={false}
        onNavigationOpenChange={() => undefined}
        onDesktopActivityOpenChange={() => undefined}
        onMobileActivityOpenChange={() => undefined}
      />
    </div>
  ),
};
