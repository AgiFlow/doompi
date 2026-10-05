import { slotPropsFixture } from '@agimon-ai/doompi-core/webTesting';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, it, vi } from 'vitest';

const api = vi.hoisted(() => ({ styleSystemCatalog: vi.fn() }));
vi.mock('../../src/extensions/workspaces/sessions/(frontend)/_lib/previewApi', () => api);
vi.mock('../../src/extensions/workspaces/sessions/(frontend)/_components/StoryPreviewPanel', () => ({
  StoryPreviewPanel: () => <div data-testid="selected-preview" />,
}));

import {
  StyleSystemBrowser,
  styleSystemTab,
} from '../../src/extensions/workspaces/sessions/(frontend)/_components/StyleSystemBrowser';
import {
  authorSourceActionSlot,
  browserSelection,
  filteredComponents,
  forgetBrowserSelection,
  initialBrowserSelection,
  rememberBrowserSelection,
} from '../../src/extensions/workspaces/sessions/(frontend)/_lib/styleSystemBrowser';
import activity from '../../src/extensions/workspaces/sessions/(frontend)/activity-group/style-system.web';
import type { StyleSystemCatalogView } from '../../src/types/styleSystemCatalog';

const catalog: StyleSystemCatalogView = {
  projects: [
    {
      appPath: 'apps/web',
      configPath: 'apps/web/style-system.config.yaml',
      preset: 'web-app',
      settings: {},
      provenance: { presets: ['web-app'] },
    },
  ],
  components: [
    {
      title: 'Button',
      storyPath: 'packages/ui/Button.stories.tsx',
      tags: ['style-system'],
      shared: true,
      exports: [{ exportName: 'Disabled' }],
    },
    {
      title: 'Button',
      storyPath: 'apps/web/Button.stories.tsx',
      projectPath: 'apps/web',
      tags: ['web'],
      shared: false,
      exports: [{ exportName: 'Playground' }],
    },
  ],
  diagnostics: [],
  truncated: false,
};
afterEach(() => {
  forgetBrowserSelection('session');
  vi.clearAllMocks();
});

describe('Style system browser', () => {
  it('filters by path, variant, tag and project without collapsing duplicate titles', () => {
    const selection = initialBrowserSelection();
    expect(filteredComponents(catalog, selection)).toHaveLength(2);
    expect(
      filteredComponents(catalog, { ...selection, search: 'BUTTON disabled' }).map((entry) => entry.storyPath),
    ).toEqual(['packages/ui/Button.stories.tsx']);
    expect(
      filteredComponents(catalog, { ...selection, scope: 'project:apps/web', preset: 'web-app', tag: 'web' }),
    ).toHaveLength(1);
    expect(filteredComponents(catalog, { ...selection, scope: 'shared' })).toHaveLength(1);
    expect(filteredComponents(catalog, { ...selection, scope: 'unassigned' })).toHaveLength(1);
    expect(filteredComponents(catalog, { ...selection, tag: 'missing' })).toHaveLength(0);
  });
  it('opens one stable idle tab and retains session selection until close', () => {
    expect(activity.name).toBe('style system');
    expect(activity.marksBackgroundWork).toBe(false);
    expect(activity.activeSource?.isActive('session')).toBe(false);
    expect(styleSystemTab().id).toBe(styleSystemTab().id);
    expect(styleSystemTab().label).toBe('style system');
    rememberBrowserSelection('session', { ...initialBrowserSelection(), search: 'Button' });
    expect(browserSelection('session').search).toBe('Button');
    expect(browserSelection('other').search).toBe('');
    styleSystemTab().onClose?.('session');
    expect(browserSelection('session').search).toBe('');
  });
  it('does not mount a preview for catalog browsing or unassigned shared stories', () => {
    const props = slotPropsFixture({ sessionId: 'session' }).props;
    expect(renderToStaticMarkup(<StyleSystemBrowser {...props} initialCatalog={catalog} />)).not.toContain(
      'selected-preview',
    );
    rememberBrowserSelection('session', {
      ...initialBrowserSelection(),
      storyPath: catalog.components[0]!.storyPath,
      storyExport: 'Disabled',
    });
    const html = renderToStaticMarkup(<StyleSystemBrowser {...props} initialCatalog={catalog} />);
    expect(html).toContain('Choose a consuming project');
    expect(html).not.toContain('selected-preview');
    expect(api.styleSystemCatalog).not.toHaveBeenCalled();
  });
  it('mounts only the selected preview and gates Author on active mode and explicit capability', () => {
    rememberBrowserSelection('session', {
      ...initialBrowserSelection(),
      storyPath: catalog.components[1]!.storyPath,
      storyExport: 'Playground',
      appPath: 'apps/web',
    });
    const props = slotPropsFixture({ sessionId: 'session' }).props;
    expect(renderToStaticMarkup(<StyleSystemBrowser {...props} initialCatalog={catalog} />)).toContain(
      'selected-preview',
    );
    expect(renderToStaticMarkup(<StyleSystemBrowser {...props} initialCatalog={catalog} />)).not.toContain(
      'Open in Author',
    );
    const action = { version: 1 as const, createTab: vi.fn() };
    const authorProps = {
      ...props,
      activeMinorModes: ['author'],
      slotData: () => [{ pluginId: 'author', id: 'author', order: 0, data: action }],
    } as unknown as typeof props;
    expect(renderToStaticMarkup(<StyleSystemBrowser {...authorProps} initialCatalog={catalog} />)).toContain(
      'Open in Author',
    );
    expect(authorSourceActionSlot.parse?.({ version: 1, createTab: 'bad' })).toBeNull();
  });
});
