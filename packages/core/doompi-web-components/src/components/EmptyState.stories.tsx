/*
 * Plain CSF objects; see Badge.stories.tsx for why Storybook's types are not
 * imported. `Playground` is the story the DoomPi style-system extension renders
 * by default.
 */
import { Button } from './Button';
import { EmptyState } from './EmptyState';

const meta = {
  title: 'Components/EmptyState',
  component: EmptyState,
  tags: ['style-system'],
};

export default meta;

export const Playground = {
  render: () => (
    <div className="flex flex-col gap-6 bg-doom-bg p-6">
      <div className="flex flex-col gap-2">
        <span className="text-2xs text-doom-dim uppercase tracking-widest">title only</span>
        <EmptyState title="no sessions yet" />
      </div>
      <div className="flex flex-col gap-2">
        <span className="text-2xs text-doom-dim uppercase tracking-widest">with description</span>
        <EmptyState title="no sessions yet" description="A session appears here as soon as one starts in the rail." />
      </div>
      <div className="flex flex-col gap-2">
        <span className="text-2xs text-doom-dim uppercase tracking-widest">with actions</span>
        <EmptyState title="nothing to review" description="Every run in this window finished without a diff.">
          <div className="flex items-center gap-2">
            <Button variant="primary" size="sm">
              new session
            </Button>
            <Button variant="outline" size="sm">
              open the log
            </Button>
          </div>
        </EmptyState>
      </div>
      <div className="flex flex-col gap-2">
        <span className="text-2xs text-doom-dim uppercase tracking-widest">inside a panel</span>
        <div className="flex h-40 rounded-md border border-doom-border bg-doom-deep">
          <EmptyState title="no output" description="This tool call returned nothing." />
        </div>
      </div>
      <div className="flex flex-col gap-2">
        <span className="text-2xs text-doom-dim uppercase tracking-widest">as child, an empty list row</span>
        <ul className="flex flex-col rounded-md border border-doom-border">
          <EmptyState asChild title="no results">
            <li />
          </EmptyState>
        </ul>
      </div>
    </div>
  ),
};
