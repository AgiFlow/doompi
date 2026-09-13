/*
 * Plain CSF objects; the style-system renderer resolves the default export by
 * looking for a bare `const meta`, so the export is not named at the point of
 * definition.
 *
 * The boundary draws nothing of its own, so the interesting state is a child
 * that throws: React catches it, re-runs the render prop with `failed`, and
 * the host item stands in. The throw is logged once by componentDidCatch.
 */
import { ToolRendererBoundary } from './ToolRendererBoundary';

function PluginItem() {
  return (
    <div className="rounded-md border border-doom-border bg-doom-panel px-3 py-2 text-sm text-doom-text">
      the plugin's own tool item
    </div>
  );
}

function ThrowingPluginItem(): null {
  throw new Error('the plugin renderer read a field the result does not carry');
}

function HostFallbackItem() {
  return (
    <div className="rounded-md border border-doom-border-soft bg-doom-deep px-3 py-2 text-sm text-doom-dim">
      read · src/lib/cn.ts
    </div>
  );
}

const meta = {
  title: 'Web/ToolRendererBoundary',
  component: ToolRendererBoundary,
  tags: ['style-system'],
};

export default meta;

export const Playground = {
  render: () => (
    <div className="flex flex-col gap-6 bg-doom-bg p-6">
      <div className="flex flex-col gap-2">
        <span className="text-2xs text-doom-dim uppercase tracking-widest">renderer holds</span>
        <ToolRendererBoundary toolName="read">
          {(failed) => (failed ? <HostFallbackItem /> : <PluginItem />)}
        </ToolRendererBoundary>
      </div>

      <div className="flex flex-col gap-2">
        <span className="text-2xs text-doom-dim uppercase tracking-widest">renderer threw · host item stands in</span>
        <ToolRendererBoundary toolName="read">
          {(failed) => (failed ? <HostFallbackItem /> : <ThrowingPluginItem />)}
        </ToolRendererBoundary>
      </div>
    </div>
  ),
};
