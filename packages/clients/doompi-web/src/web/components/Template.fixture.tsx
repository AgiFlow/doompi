import { defineWebPlugin, type WebTemplateProps } from '@agimon-ai/doompi-core/web';

import type { SettingsConfigView } from '../../types/settings.ts';
import { installWebPlugins, resetWebPlugins } from '../lib/pluginRegistry.ts';
import { webPluginCompositionStore } from '../lib/pluginRuntime.ts';
import { templateStore } from '../stores/templateStore.ts';
import { STORY_SESSION_ID, STORY_WORKSPACE_ID } from './Story.fixture.tsx';

export const templateConfig: SettingsConfigView = {
  repoRoot: '/workspace/doompi',
  values: { 'web.template': { value: 'story-layout', origin: 'global', scope: 'both' } },
  hashes: { global: 'story-global', repository: 'story-repository' },
};

export const storyTemplate = defineWebPlugin({
  id: 'story-template',
  templates: [
    {
      id: 'story-layout',
      label: 'Story layout',
      description: 'An isolated layout for exercising host slots.',
      contractVersion: 1,
      layout: ({ slots }) => (
        <div className="flex h-full min-w-0 flex-col bg-doom-bg text-doom-text">
          {slots.notices}
          {slots.header({ navigationToggle: 'always', activityToggle: 'always' })}
          <div className="flex min-h-0 min-w-0 flex-1">
            {slots.navigation}
            <main className="flex min-h-0 min-w-0 flex-1 flex-col">
              <div className="min-h-0 flex-1 overflow-y-auto">{slots.content}</div>
              {slots.composer}
              {slots.controls}
            </main>
            {slots.activity}
          </div>
        </div>
      ),
    },
  ],
});

export function seedTemplateStory(phase: 'ready' | 'loading' | 'error' = 'ready', includeTemplate = true): void {
  resetWebPlugins();
  installWebPlugins(includeTemplate ? [storyTemplate] : []);
  const state = { phase, ...(phase === 'error' ? { error: 'The template package could not be loaded.' } : {}) };
  webPluginCompositionStore.setState(() => ({
    ...state,
    mounts: {
      global: state,
      [`workspace:${STORY_WORKSPACE_ID}`]: state,
      [`session:${STORY_SESSION_ID}`]: state,
    },
  }));
  templateStore.setState(() => ({
    global: { config: templateConfig, loading: false, saving: false },
    [`workspace:${STORY_WORKSPACE_ID}`]: { config: templateConfig, loading: false, saving: false },
  }));
}

export const templateProps: WebTemplateProps = {
  view: 'conversation',
  navigationOpen: false,
  desktopActivityOpen: false,
  mobileActivityOpen: false,
  onNavigationOpenChange: () => undefined,
  onDesktopActivityOpenChange: () => undefined,
  onMobileActivityOpenChange: () => undefined,
  slots: {
    navigation: null,
    activity: null,
    notices: null,
    controls: null,
    composer: null,
    header: () => (
      <header className="border-b border-doom-border p-4 text-sm text-doom-hi">Component review workspace</header>
    ),
    content: <div className="p-6 text-sm text-doom-text">The selected template renders the host content here.</div>,
  },
};
