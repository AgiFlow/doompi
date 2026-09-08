/*
 * Plain CSF objects; see Badge.stories.tsx for why Storybook's types are not
 * imported. `Playground` is the story the DoomPi style-system extension renders
 * by default.
 */
import { StreamCursor } from './StreamCursor.tsx';

const meta = {
  title: 'Components/StreamCursor',
  component: StreamCursor,
  tags: ['style-system'],
};

export default meta;

export const Playground = {
  render: () => (
    <div className="flex flex-col gap-6 bg-doom-bg p-6">
      <div className="flex flex-col gap-2">
        <span className="text-2xs text-doom-dim uppercase tracking-widest">default</span>
        <StreamCursor />
      </div>
      <div className="flex flex-col gap-2">
        <span className="text-2xs text-doom-dim uppercase tracking-widest">trailing a line of text</span>
        <span className="font-mono text-sm text-doom-text">
          reading the file
          <StreamCursor />
        </span>
      </div>
      <div className="flex flex-col gap-2">
        <span className="text-2xs text-doom-dim uppercase tracking-widest">on a larger ramp</span>
        <span className="font-mono text-base text-doom-hi">
          still thinking
          <StreamCursor />
        </span>
      </div>
    </div>
  ),
};
