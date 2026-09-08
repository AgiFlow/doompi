/*
 * Plain CSF objects; see Badge.stories.tsx for why Storybook's types are not
 * imported. `Playground` is the story the DoomPi style-system extension renders
 * by default.
 *
 * `open` is passed rather than `defaultOpen` so both states paint side by side
 * without a click.
 */
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from './Collapsible.tsx';

const meta = {
  title: 'Components/Collapsible',
  component: Collapsible,
  tags: ['style-system'],
};

export default meta;

const SHELL = 'w-80 overflow-hidden rounded-md border border-doom-border bg-doom-panel';
const TRIGGER = 'flex w-full cursor-pointer items-center justify-between gap-2 px-3 py-2 text-sm text-doom-hi';
const CONTENT = 'border-t border-doom-border-soft bg-doom-deep px-3 py-2 text-sm text-doom-dim';

export const Playground = {
  render: () => (
    <div className="flex flex-col gap-6 bg-doom-bg p-6">
      <div className="flex flex-col gap-2">
        <span className="text-2xs text-doom-dim uppercase tracking-widest">state open</span>
        <Collapsible open className={SHELL}>
          <CollapsibleTrigger className={TRIGGER}>
            environment
            <span className="text-2xs text-doom-faint uppercase tracking-wider">hide</span>
          </CollapsibleTrigger>
          <CollapsibleContent className={CONTENT}>
            NODE_ENV=production
            <br />
            DOOM_LOG_LEVEL=info
          </CollapsibleContent>
        </Collapsible>
      </div>
      <div className="flex flex-col gap-2">
        <span className="text-2xs text-doom-dim uppercase tracking-widest">state closed</span>
        <Collapsible open={false} className={SHELL}>
          <CollapsibleTrigger className={TRIGGER}>
            environment
            <span className="text-2xs text-doom-faint uppercase tracking-wider">show</span>
          </CollapsibleTrigger>
          <CollapsibleContent className={CONTENT}>
            NODE_ENV=production
            <br />
            DOOM_LOG_LEVEL=info
          </CollapsibleContent>
        </Collapsible>
      </div>
    </div>
  ),
};
