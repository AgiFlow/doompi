/*
 * Plain CSF objects; see Badge.stories.tsx for why Storybook's types are not
 * imported. `Playground` is the story the DoomPi style-system extension renders
 * by default.
 *
 * The tone table is drawn straight from `toastVariants` rather than from the
 * `Toast` root. Radix's root portals into the viewport during render, and a
 * viewport mounted in the same commit is still null at that point, so a toast
 * declared open beside its own viewport throws before it can paint. Everything
 * inside the surface is the real part: only the <li> wrapper is stood in for.
 */
import { STATUS_TONES } from '../types/tone';
import { Toast, ToastClose, ToastDescription, ToastTitle, toastVariants } from './Toast';

const meta = {
  title: 'Components/Toast',
  component: Toast,
  tags: ['style-system'],
};

export default meta;

export const Playground = {
  render: () => (
    <div className="flex flex-col gap-6 bg-doom-bg p-6">
      {STATUS_TONES.map((tone) => (
        <div key={tone} className="flex flex-col gap-2">
          <span className="text-2xs text-doom-dim uppercase tracking-widest">tone {tone}</span>
          <div className={`${toastVariants({ tone })} w-full max-w-sm`}>
            <div className="flex min-w-0 flex-1 flex-col gap-1">
              <ToastTitle>build finished</ToastTitle>
              <ToastDescription>42 files changed in 3.1s.</ToastDescription>
            </div>
            <ToastClose />
          </div>
        </div>
      ))}
    </div>
  ),
};
