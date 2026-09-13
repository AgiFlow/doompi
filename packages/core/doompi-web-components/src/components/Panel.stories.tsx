/*
 * Plain CSF objects; see Badge.stories.tsx for why Storybook's types are not
 * imported. `Playground` is the story the DoomPi style-system extension renders
 * by default.
 */
import { Panel, PanelBody, PanelHeader } from './Panel';

const meta = {
  title: 'Components/Panel',
  component: Panel,
  tags: ['style-system'],
};

export default meta;

const LABEL = 'text-2xs text-doom-dim uppercase tracking-widest';

export const Playground = {
  render: () => (
    <div className="flex flex-col gap-6 bg-doom-bg p-6">
      <div className="flex flex-wrap items-start gap-6">
        <div className="flex flex-col gap-2">
          <span className={LABEL}>surface only</span>
          <Panel className="w-72 px-3 py-2 text-sm text-doom-dim">
            The bordered card with nothing inside it but its own padding.
          </Panel>
        </div>

        <div className="flex flex-col gap-2">
          <span className={LABEL}>header and body</span>
          <Panel className="w-72">
            <PanelHeader>
              <span className="text-sm font-bold text-doom-hi">bash</span>
              <span className="text-2xs text-doom-faint uppercase tracking-wider">exit 0</span>
            </PanelHeader>
            <PanelBody>pnpm nx run doompi-web-components:test</PanelBody>
          </Panel>
        </div>

        <div className="flex flex-col gap-2">
          <span className={LABEL}>as child</span>
          <Panel asChild>
            <section className="w-72">
              <PanelHeader>
                <span className="text-sm font-bold text-doom-hi">session 04</span>
              </PanelHeader>
              <PanelBody>A list row rendered as the panel itself, not wrapped in one.</PanelBody>
            </section>
          </Panel>
        </div>
      </div>
    </div>
  ),
};
