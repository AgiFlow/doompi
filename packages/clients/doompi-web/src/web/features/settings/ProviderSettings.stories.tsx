import { StoryFrame } from '../../components/Story.fixture.tsx';
import { ProviderSettings } from './ProviderSettings.tsx';
import { seedSettingsStory } from './settings.fixture.ts';

const meta = { title: 'Web/ProviderSettings', component: ProviderSettings, tags: ['style-system'] };
export default meta;

export const Playground = {
  render: () => {
    seedSettingsStory();
    return (
      <StoryFrame>
        <ProviderSettings />
      </StoryFrame>
    );
  },
};

export const Empty = {
  render: () => {
    seedSettingsStory({ 'GET /api/plugins/doompi/providers': { providers: [] } });
    return (
      <StoryFrame>
        <ProviderSettings />
      </StoryFrame>
    );
  },
};

export const Unavailable = {
  render: () => {
    seedSettingsStory({
      'GET /api/plugins/doompi/providers': Response.json(
        { error: 'Provider settings are temporarily unavailable.' },
        { status: 503 },
      ),
    });
    return (
      <StoryFrame>
        <ProviderSettings />
      </StoryFrame>
    );
  },
};
