import { createRef } from 'react';

import { type TerminalHandle, TerminalView } from './TerminalView';

const meta = {
  title: 'Components/TerminalView',
  component: TerminalView,
  tags: ['style-system'],
};

export default meta;

const OUTPUT =
  '\u001b[32mPASS\u001b[0m component review\r\n\u001b[33mWARN\u001b[0m long output scrolls inside the terminal\r\n$ pnpm test\r\n';

export const Playground = {
  render: () => {
    const standard = createRef<TerminalHandle>();
    const large = createRef<TerminalHandle>();
    return (
      <div className="flex flex-col gap-6 bg-doom-bg p-6">
        <div className="flex flex-col gap-2">
          <span className="text-2xs text-doom-faint uppercase tracking-widest">default font size</span>
          <div className="h-40 bg-doom-deep">
            <TerminalView ref={standard} onReady={() => standard.current?.write(OUTPUT)} />
          </div>
        </div>
        <div className="flex flex-col gap-2">
          <span className="text-2xs text-doom-faint uppercase tracking-widest">font size 14</span>
          <div className="h-40 bg-doom-deep">
            <TerminalView ref={large} fontSize={14} onReady={() => large.current?.write(OUTPUT)} />
          </div>
        </div>
      </div>
    );
  },
};
