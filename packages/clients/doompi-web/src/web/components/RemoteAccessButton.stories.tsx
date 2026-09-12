/*
 * Plain CSF objects; the style-system renderer resolves the default export by
 * looking for a bare `const meta`, so the export is not named at the point of
 * definition.
 */
import { RemoteAccessButton } from './RemoteAccessButton';

const noop = (): void => undefined;

const meta = {
  title: 'Web/RemoteAccessButton',
  component: RemoteAccessButton,
  tags: ['style-system'],
};

export default meta;

export const Playground = {
  render: () => (
    <div className="flex flex-col gap-6 bg-doom-bg p-6">
      <div className="flex flex-col gap-2">
        <span className="text-2xs text-doom-dim uppercase tracking-widest">off</span>
        <div className="w-fit">
          <RemoteAccessButton status="off" deviceCount={0} onOpen={noop} />
        </div>
      </div>

      <div className="flex flex-col gap-2">
        <span className="text-2xs text-doom-dim uppercase tracking-widest">starting</span>
        <div className="w-fit">
          <RemoteAccessButton status="starting" deviceCount={0} onOpen={noop} />
        </div>
      </div>

      <div className="flex flex-col gap-2">
        <span className="text-2xs text-doom-dim uppercase tracking-widest">on · one device paired</span>
        <div className="w-fit">
          <RemoteAccessButton status="on" deviceCount={1} onOpen={noop} />
        </div>
      </div>

      <div className="flex flex-col gap-2">
        <span className="text-2xs text-doom-dim uppercase tracking-widest">failed</span>
        <div className="w-fit">
          <RemoteAccessButton status="failed" deviceCount={0} onOpen={noop} />
        </div>
      </div>

      <div className="flex flex-col gap-2">
        <span className="text-2xs text-doom-dim uppercase tracking-widest">in the sessions rail header</span>
        <div className="flex w-fit items-center gap-2 rounded-md border border-doom-border bg-doom-panel px-3 py-2">
          <span className="text-sm text-doom-hi tracking-wide">DOOM</span>
          <RemoteAccessButton status="on" deviceCount={3} onOpen={noop} />
        </div>
      </div>
    </div>
  ),
};
