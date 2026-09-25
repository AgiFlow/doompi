import { StoryFrame } from '../../components/Story.fixture.tsx';
import { SessionMcpSettings } from './SessionMcpSettings.tsx';
import { seedSettingsStory, mcpRoute } from './settings.fixture.ts';

const meta = { title: 'Web/SessionMcpSettings', component: SessionMcpSettings, tags: ['style-system'] };
export default meta;

export const Playground = {
  render: () => {
    seedSettingsStory();
    return (
      <StoryFrame>
        <SessionMcpSettings />
      </StoryFrame>
    );
  },
};

export const NoClients = {
  render: () => {
    seedSettingsStory({ [`GET ${mcpRoute}/clients`]: { clients: [] } });
    return (
      <StoryFrame>
        <SessionMcpSettings />
      </StoryFrame>
    );
  },
};
