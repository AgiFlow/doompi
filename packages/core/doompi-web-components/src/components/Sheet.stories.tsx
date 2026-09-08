/*
 * Plain CSF objects; see Badge.stories.tsx for why Storybook's types are not
 * imported. `Playground` is the story the DoomPi style-system extension renders
 * by default.
 *
 * Both roots are `open`. A sheet is pinned to an edge and portalled to
 * document.body, so the two sides paint at once without overlapping; the
 * wrapper keeps a min-height so the screenshot has room behind them.
 */
import { Button } from './Button.tsx';
import { Sheet, SheetBody, SheetContent, SheetDescription, SheetFooter, SheetHeader, SheetTitle } from './Sheet.tsx';

const meta = {
  title: 'Components/Sheet',
  component: Sheet,
  tags: ['style-system'],
};

export default meta;

const LABEL = 'text-2xs text-doom-dim uppercase tracking-widest';

export const Playground = {
  render: () => (
    <div className="flex min-h-96 flex-col gap-6 bg-doom-bg p-6">
      <span className={LABEL}>sheets render over this surface</span>

      <Sheet open>
        <SheetContent side="left" width="sm">
          <SheetHeader dismissible={false}>
            <SheetTitle>filters</SheetTitle>
          </SheetHeader>
          <SheetBody>
            <span className={LABEL}>side left / width sm / header plain</span>
            <SheetDescription>
              The narrow preset with the close control turned off, for a sheet whose header already owns its right edge.
            </SheetDescription>
          </SheetBody>
        </SheetContent>
      </Sheet>

      <Sheet open>
        <SheetContent side="right" width="lg">
          <SheetHeader>
            <SheetTitle>run detail</SheetTitle>
          </SheetHeader>
          <SheetBody>
            <span className={LABEL}>side right / width lg / header dismissible</span>
            <SheetDescription>
              The wide preset with the default close control. Between these two sits `width=&quot;md&quot;`, the
              default.
            </SheetDescription>
          </SheetBody>
          <SheetFooter>
            <span className="text-2xs text-doom-faint">esc to close</span>
            <Button variant="primary" size="sm">
              rerun
            </Button>
          </SheetFooter>
        </SheetContent>
      </Sheet>
    </div>
  ),
};
