import { ElegantLayout } from './ElegantLayout';

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
    <div className="flex h-12 items-center justify-between border-b border-doom-border px-5">
      <span className="text-base font-bold text-doom-hi">Template architecture</span>
      <span className="text-xs text-doom-faint">activity</span>
    </div>
  ),
  notices: null,
  content: (
    <div className="flex min-h-0 flex-1 flex-col gap-6 overflow-y-auto px-4 py-8 text-sm leading-relaxed text-doom-text">
      <div>Elegant keeps the conversation calm and centered while secondary UI stays available on demand.</div>
      <div className="self-end rounded-lg bg-doom-panel px-5 py-4 text-doom-hi">
        The session, tools, plugins, and theme remain the same.
      </div>
    </div>
  ),
  composer: (
    <div className="px-4 py-3">
      <div className="min-h-16 rounded-lg px-2 py-2 text-sm text-doom-dim">Ask DoomPi anything…</div>
      <div className="pt-2 text-xs text-doom-faint">attach · model · send</div>
    </div>
  ),
  controls: <div className="px-3 py-2 text-xs text-doom-faint">mode · model · context</div>,
  activity: <div className="p-4 text-sm text-doom-text">Activity content</div>,
};

const meta = { title: 'Templates/ElegantLayout', component: ElegantLayout, tags: ['style-system'] };
export default meta;

export const Playground = {
  render: () => (
    <div className="h-[720px] w-[1180px] bg-doom-bg">
      <ElegantLayout
        view="conversation"
        slots={slots}
        navigationOpen={false}
        desktopActivityOpen={false}
        mobileActivityOpen={false}
        onNavigationOpenChange={() => undefined}
        onDesktopActivityOpenChange={() => undefined}
        onMobileActivityOpenChange={() => undefined}
      />
    </div>
  ),
};
