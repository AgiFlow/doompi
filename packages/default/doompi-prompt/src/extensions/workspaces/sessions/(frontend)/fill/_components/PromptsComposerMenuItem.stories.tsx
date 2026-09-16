/*
 * Plain CSF objects; the style-system renderer resolves the default export by
 * finding a bare `const meta`, so it is not named at the point of definition.
 *
 * The row is sized by the composer menu that owns it, so it is drawn inside a
 * panel of that width rather than stretched across the viewport.
 */
import { PromptsComposerMenuItem } from './PromptsComposerMenuItem';

const meta = {
  title: 'Prompt/PromptsComposerMenuItem',
  component: PromptsComposerMenuItem,
  tags: ['style-system'],
};

export default meta;

export const Playground = {
  render: () => (
    <div className="flex flex-col gap-6 bg-doom-bg p-6">
      <div className="flex flex-col gap-2">
        <span className="text-2xs text-doom-dim uppercase tracking-widest">in a composer menu</span>
        <div
          role="menu"
          className="w-64 rounded-md border border-doom-border-soft bg-doom-panel p-1"
          aria-label="composer actions"
        >
          <PromptsComposerMenuItem />
        </div>
      </div>
    </div>
  ),
};
