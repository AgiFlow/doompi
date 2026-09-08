import { TerminalView } from './TerminalView.tsx';

const meta = {
  title: 'Components/TerminalView',
  component: TerminalView,
  tags: ['style-system'],
};

export default meta;

export const Playground = {
  render: () => (
    <div className="flex flex-col gap-6 bg-doom-bg p-6">
      <div className="flex flex-col gap-2">
        <span className="text-2xs text-doom-faint uppercase tracking-widest">default font size</span>
        <div className="h-40 bg-doom-deep">
          <TerminalView />
        </div>
      </div>
      <div className="flex flex-col gap-2">
        <span className="text-2xs text-doom-faint uppercase tracking-widest">font size 14</span>
        <div className="h-40 bg-doom-deep">
          <TerminalView fontSize={14} />
        </div>
      </div>
    </div>
  ),
};
