/*
 * Plain CSF objects; see Badge.stories.tsx for why Storybook's types are not
 * imported. `Playground` is the story the DoomPi style-system extension renders
 * by default.
 *
 * Every root is `open` so the anchored content paints without a click. The
 * content is portalled and positioned against its trigger, so the triggers sit
 * in a three-column grid and the wrapper keeps a min-height for the drop.
 */
import { Button } from './Button';
import { Popover, PopoverContent, PopoverFooter, PopoverHeader, PopoverTrigger } from './Popover';

const meta = {
  title: 'Components/Popover',
  component: Popover,
  tags: ['style-system'],
};

export default meta;

const LABEL = 'text-2xs text-doom-dim uppercase tracking-widest';

export const Playground = {
  render: () => (
    <div className="flex min-h-96 flex-col gap-6 bg-doom-bg p-6">
      <div className="grid grid-cols-3 items-start gap-6">
        <div className="flex flex-col gap-2">
          <span className={LABEL}>align start / body only</span>
          <Popover open>
            <PopoverTrigger asChild>
              <Button variant="outline" size="sm">
                branch
              </Button>
            </PopoverTrigger>
            <PopoverContent className="w-64">
              <div className="flex flex-col gap-1 px-3 py-2 text-sm text-doom-dim">
                <span className="text-doom-hi">main</span>
                <span>feat/style-system</span>
                <span>fix/toast-viewport</span>
              </div>
            </PopoverContent>
          </Popover>
        </div>

        <div className="flex flex-col gap-2">
          <span className={LABEL}>align center / header and footer</span>
          <Popover open>
            <PopoverTrigger asChild>
              <Button variant="outline" size="sm">
                model
              </Button>
            </PopoverTrigger>
            <PopoverContent align="center" className="w-64">
              <PopoverHeader>
                <span className="text-sm font-bold text-doom-hi">pick a model</span>
              </PopoverHeader>
              <div className="flex flex-col gap-1 px-3 py-2 text-sm text-doom-dim">
                <span className="text-doom-hi">sonnet</span>
                <span>opus</span>
              </div>
              <PopoverFooter>
                <span>enter to select</span>
                <span>esc to close</span>
              </PopoverFooter>
            </PopoverContent>
          </Popover>
        </div>

        <div className="flex flex-col gap-2">
          <span className={LABEL}>align end / side right</span>
          <Popover open>
            <PopoverTrigger asChild>
              <Button variant="outline" size="sm">
                usage
              </Button>
            </PopoverTrigger>
            <PopoverContent align="end" className="w-64">
              <PopoverHeader>
                <span className="text-sm font-bold text-doom-hi">this run</span>
              </PopoverHeader>
              <div className="px-3 py-2 text-sm text-doom-dim">18.4k in / 2.1k out</div>
            </PopoverContent>
          </Popover>
        </div>
      </div>
    </div>
  ),
};
