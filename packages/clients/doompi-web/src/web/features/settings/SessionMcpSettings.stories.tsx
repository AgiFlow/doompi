import { remoteView } from '../../components/Remote.fixture.tsx';
import { StoryFrame } from '../../components/Story.fixture.tsx';
import { remoteAccessStore } from '../../stores/remoteAccessStore.ts';
import { SessionMcpSettings } from './SessionMcpSettings.tsx';
import { seedSettingsStory, mcpRoute } from './settings.fixture.ts';

const meta = { title: 'Web/SessionMcpSettings', component: SessionMcpSettings, tags: ['style-system'] };
export default meta;

export const Playground = {
  render: () => {
    seedSettingsStory();
    remoteAccessStore.setState((state) => ({
      ...state,
      view: { ...remoteView, status: 'on', publicUrl: 'https://example.invalid' },
    }));
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
    remoteAccessStore.setState((state) => ({
      ...state,
      view: { ...remoteView, status: 'on', publicUrl: 'https://example.invalid' },
    }));
    return (
      <StoryFrame>
        <SessionMcpSettings />
      </StoryFrame>
    );
  },
};
