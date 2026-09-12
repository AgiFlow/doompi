/*
 * Plain CSF objects; see Badge.stories.tsx for why Storybook's types are not
 * imported. `Playground` is the story the DoomPi style-system extension renders
 * by default.
 */
import { ToolPathLink } from './ToolPathLink';

const PATH = 'packages/core/doompi-web-components/src/components/ToolPathLink.tsx';

/** Stories never click; the link only needs a handler to render as a button. */
const noop = () => {};

const meta = {
  title: 'Components/ToolPathLink',
  component: ToolPathLink,
  tags: ['style-system'],
};

export default meta;

export const Playground = {
  render: () => (
    <div className="flex flex-col gap-6 bg-doom-bg p-6">
      <div className="flex flex-col gap-2">
        <span className="text-2xs text-doom-dim uppercase tracking-widest">no onOpen, plain text</span>
        <span className="font-mono text-sm">
          <ToolPathLink path={PATH} />
        </span>
      </div>
      <div className="flex flex-col gap-2">
        <span className="text-2xs text-doom-dim uppercase tracking-widest">with onOpen, a link</span>
        <span className="font-mono text-sm">
          <ToolPathLink path={PATH} onOpen={noop} />
        </span>
      </div>
      <div className="flex flex-col gap-2">
        <span className="text-2xs text-doom-dim uppercase tracking-widest">in a tool call header</span>
        <div className="flex items-center gap-2 rounded-md border border-doom-border bg-doom-deep px-2 py-1 font-mono text-sm">
          <span className="shrink-0 text-doom-dim uppercase tracking-wide">read</span>
          <ToolPathLink path={PATH} onOpen={noop} />
        </div>
      </div>
      <div className="flex flex-col gap-2">
        <span className="text-2xs text-doom-dim uppercase tracking-widest">truncated by a narrow container</span>
        <div className="flex w-48 rounded-md border border-doom-border bg-doom-deep px-2 py-1 font-mono text-sm">
          <ToolPathLink path={PATH} onOpen={noop} />
        </div>
      </div>
    </div>
  ),
};
