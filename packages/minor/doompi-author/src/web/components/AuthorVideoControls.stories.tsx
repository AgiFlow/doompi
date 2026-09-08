/*
 * Plain CSF objects; the style-system renderer resolves the default export by
 * looking for a bare `const meta`. The controls are fully driven by props, so
 * each variant is one combination of playback, readiness and the draft lock.
 */
import { AuthorVideoControls } from './AuthorVideoControls.tsx';

const noop = () => undefined;

const meta = {
  title: 'Author/AuthorVideoControls',
  component: AuthorVideoControls,
  tags: ['style-system'],
};

export default meta;

export const Playground = {
  render: () => (
    <div className="flex flex-col gap-6 bg-doom-bg p-6">
      <div className="flex w-full max-w-2xl flex-col gap-2">
        <span className="text-2xs text-doom-dim uppercase tracking-widest">paused · frame ready</span>
        <AuthorVideoControls
          playback={{ playing: false, currentTime: 12.5, duration: 94.25 }}
          ready
          locked={false}
          marking={false}
          onSeek={noop}
          onToggle={noop}
          onAnnotate={noop}
        />
      </div>

      <div className="flex w-full max-w-2xl flex-col gap-2">
        <span className="text-2xs text-doom-dim uppercase tracking-widest">playing · frame not ready</span>
        <AuthorVideoControls
          playback={{ playing: true, currentTime: 30.125, duration: 94.25 }}
          ready={false}
          locked={false}
          marking={false}
          onSeek={noop}
          onToggle={noop}
          onAnnotate={noop}
        />
      </div>

      <div className="flex w-full max-w-2xl flex-col gap-2">
        <span className="text-2xs text-doom-dim uppercase tracking-widest">marking a frame</span>
        <AuthorVideoControls
          playback={{ playing: false, currentTime: 30.125, duration: 94.25 }}
          ready
          locked={false}
          marking
          onSeek={noop}
          onToggle={noop}
          onAnnotate={noop}
        />
      </div>

      <div className="flex w-full max-w-2xl flex-col gap-2">
        <span className="text-2xs text-doom-dim uppercase tracking-widest">locked by an unsent draft</span>
        <AuthorVideoControls
          playback={{ playing: false, currentTime: 30.125, duration: 94.25 }}
          ready
          locked
          marking={false}
          onSeek={noop}
          onToggle={noop}
          onAnnotate={noop}
        />
      </div>

      <div className="flex w-full max-w-2xl flex-col gap-2">
        <span className="text-2xs text-doom-dim uppercase tracking-widest">no duration yet</span>
        <AuthorVideoControls
          playback={{ playing: false, currentTime: 0, duration: 0 }}
          ready={false}
          locked={false}
          marking={false}
          onSeek={noop}
          onToggle={noop}
          onAnnotate={noop}
        />
      </div>
    </div>
  ),
};
