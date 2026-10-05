import { slotPropsFixture } from '@agimon-ai/doompi-core/webTesting';

import type { StyleSystemCatalogView } from '../../../../../types/styleSystemCatalog';
import { StyleSystemBrowser } from './StyleSystemBrowser';

const meta = { title: 'StyleSystem/Browser', component: StyleSystemBrowser, tags: ['style-system'] };
export default meta;

const catalog: StyleSystemCatalogView = {
  projects: [
    {
      appPath: 'apps/dashboard',
      configPath: 'apps/dashboard/style-system.config.yaml',
      preset: 'web-app',
      settings: { colorScheme: 'dark', viewport: { width: 1280, height: 800 } },
      provenance: { presets: ['web-app'] },
    },
    {
      appPath: 'packages/native-ui',
      configPath: 'packages/native-ui/style-system.config.yaml',
      preset: 'native-ui',
      bundler: 'vite-react-native',
      settings: { viewport: { width: 393, height: 852 } },
      provenance: { presets: ['native-ui'] },
    },
  ],
  components: [
    {
      title: 'Components/Button',
      storyPath: 'packages/ui/Button.stories.tsx',
      tags: ['style-system'],
      shared: true,
      exports: [{ exportName: 'Playground' }, { exportName: 'Disabled' }],
    },
    {
      title: 'Dashboard/StatusBadge',
      storyPath: 'apps/dashboard/src/StatusBadge.stories.tsx',
      projectPath: 'apps/dashboard',
      tags: ['dashboard'],
      shared: false,
      exports: [{ exportName: 'Playground' }],
    },
  ],
  workspace: {
    configPath: 'style-system.config.yaml',
    settings: { root: true },
    sharedComponentTags: ['style-system'],
  },
  diagnostics: [],
  truncated: false,
};

export const Playground = {
  render: () => (
    <div className="flex h-screen w-screen bg-doom-bg">
      <StyleSystemBrowser {...slotPropsFixture({ sessionId: 'style-system-story' }).props} initialCatalog={catalog} />
    </div>
  ),
};
export const Empty = {
  render: () => (
    <div className="flex h-screen w-screen bg-doom-bg">
      <StyleSystemBrowser
        {...slotPropsFixture({ sessionId: 'style-system-empty' }).props}
        initialCatalog={{ projects: [], components: [], diagnostics: [], truncated: false }}
      />
    </div>
  ),
};
export const PartialError = {
  render: () => (
    <div className="flex h-screen w-screen bg-doom-bg">
      <StyleSystemBrowser
        {...slotPropsFixture({ sessionId: 'style-system-error' }).props}
        initialCatalog={{
          ...catalog,
          diagnostics: [{ path: 'apps/broken/style-system.config.yaml', message: 'Unknown preset: missing' }],
        }}
      />
    </div>
  ),
};
