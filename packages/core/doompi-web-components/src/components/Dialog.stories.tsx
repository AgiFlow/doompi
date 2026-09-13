/*
 * Plain CSF objects; see Badge.stories.tsx for why Storybook's types are not
 * imported. `Playground` is the story the DoomPi style-system extension renders
 * by default.
 *
 * Every root is `open`, so all three widths paint at once. A DialogContent is
 * portalled to document.body and centred with `fixed top-1/2 -translate-y-1/2`,
 * so two of the three take a `top`/`bottom` override to claim their own slot in
 * the 800px-tall render viewport instead of stacking on the centre.
 */
import { Button } from './Button';
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from './Dialog';

const meta = {
  title: 'Components/Dialog',
  component: Dialog,
  tags: ['style-system'],
};

export default meta;

const LABEL = 'text-2xs text-doom-dim uppercase tracking-widest';

export const Playground = {
  render: () => (
    <div className="flex min-h-96 flex-col gap-6 bg-doom-bg p-6">
      <span className={LABEL}>dialog renders over this surface</span>

      <Dialog open>
        <DialogContent width="sm" className="top-6 translate-y-0">
          <DialogHeader>
            <DialogTitle>discard draft</DialogTitle>
          </DialogHeader>
          <DialogBody>
            <span className={LABEL}>width sm / footer plain</span>
            <DialogDescription>The narrow preset: one question, two answers, nothing to read.</DialogDescription>
            <DialogFooter>
              <Button variant="ghost" size="sm">
                cancel
              </Button>
              <Button variant="danger" size="sm">
                discard
              </Button>
            </DialogFooter>
          </DialogBody>
        </DialogContent>
      </Dialog>

      <Dialog open>
        <DialogContent width="md">
          <DialogHeader dismissible>
            <DialogTitle>rename session</DialogTitle>
          </DialogHeader>
          <DialogBody>
            <span className={LABEL}>width md / header dismissible</span>
            <DialogDescription>
              The default preset, with the close control the header hides unless `dismissible` is set.
            </DialogDescription>
          </DialogBody>
          <DialogFooter variant="bar">
            <span className="text-2xs text-doom-faint">esc to close</span>
            <Button variant="primary" size="sm">
              save
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open>
        <DialogContent width="lg" className="top-auto bottom-6 translate-y-0">
          <DialogHeader>
            <DialogTitle>run configuration</DialogTitle>
          </DialogHeader>
          <DialogBody>
            <span className={LABEL}>width lg / footer bar</span>
            <DialogDescription>
              The wide preset, for a body that holds a form or a diff rather than a sentence.
            </DialogDescription>
          </DialogBody>
          <DialogFooter variant="bar">
            <span className="text-2xs text-doom-faint">changes apply to new runs</span>
            <div className="flex items-center gap-2">
              <Button variant="ghost" size="sm">
                cancel
              </Button>
              <Button variant="primary" size="sm">
                apply
              </Button>
            </div>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  ),
};
