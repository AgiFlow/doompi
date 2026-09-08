/*
 * Plain CSF objects; see Badge.stories.tsx for why Storybook's types are not
 * imported. The Radix tabs carry a `defaultValue` so a panel is visible
 * without a click.
 */
import { NavTab, NavTabBadge, Tabs, TabsContent, TabsList, TabsTrigger } from './Tabs.tsx';

const meta = {
  title: 'Components/Tabs',
  component: Tabs,
  tags: ['style-system'],
};

export default meta;

export const Playground = {
  render: () => (
    <div className="flex flex-col gap-6 bg-doom-bg p-6">
      <div className="flex flex-col gap-2">
        <span className="text-2xs text-doom-dim uppercase tracking-widest">tabs · panel swapped in place</span>
        <Tabs defaultValue="output" className="flex flex-col gap-2">
          <TabsList>
            <TabsTrigger value="output">output</TabsTrigger>
            <TabsTrigger value="diff">diff</TabsTrigger>
            <TabsTrigger value="logs" disabled>
              logs
            </TabsTrigger>
          </TabsList>
          <TabsContent value="output" className="rounded-md bg-doom-panel p-3 text-sm text-doom-dim">
            3 files changed, 0 failures.
          </TabsContent>
          <TabsContent value="diff" className="rounded-md bg-doom-panel p-3 text-sm text-doom-dim">
            src/components/Tabs.tsx
          </TabsContent>
        </Tabs>
      </div>

      <div className="flex flex-col gap-2">
        <span className="text-2xs text-doom-dim uppercase tracking-widest">nav tab · active</span>
        <div className="flex items-center gap-1">
          <NavTab href="#runs" active>
            runs
            <NavTabBadge active>3</NavTabBadge>
          </NavTab>
        </div>
      </div>

      <div className="flex flex-col gap-2">
        <span className="text-2xs text-doom-dim uppercase tracking-widest">nav tab · inactive</span>
        <div className="flex items-center gap-1">
          <NavTab href="#queue">
            queue
            <NavTabBadge>12</NavTabBadge>
          </NavTab>
          <NavTab href="#settings">settings</NavTab>
        </div>
      </div>
    </div>
  ),
};
