import { Button } from './Button.tsx';
import { Drawer } from './Drawer.tsx';

const meta = {
  title: 'Components/Drawer',
  component: Drawer,
  tags: ['style-system'],
};

export default meta;

function preview(side: 'left' | 'right', showHeader = true) {
  return (
    <div className="min-h-screen bg-doom-bg p-6">
      <p className="text-sm text-doom-dim">The drawer overlays the workspace and keeps its content scrollable.</p>
      <Drawer open onOpenChange={() => undefined} side={side} title="Session context" showHeader={showHeader}>
        <div className="flex flex-col gap-4 p-4">
          <p className="text-sm text-doom-text">Review attached files and session notes before continuing.</p>
          <p className="break-words text-sm text-doom-dim">src/features/session/a-long-component-name.tsx</p>
          <Button variant="primary">Attach context</Button>
        </div>
      </Drawer>
    </div>
  );
}

export const Playground = { render: () => preview('right') };
export const Left = { render: () => preview('left') };
export const Headerless = { render: () => preview('right', false) };
