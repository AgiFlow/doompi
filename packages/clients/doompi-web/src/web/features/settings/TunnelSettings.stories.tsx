import { StoryFrame } from '../../components/Story.fixture.tsx';
import { seedSettingsStory } from './settings.fixture.ts';
import { TunnelSettings } from './TunnelSettings.tsx';

const meta = { title: 'Web/TunnelSettings', component: TunnelSettings, tags: ['style-system'] };
export default meta;

export const Playground = {
  render: () => {
    seedSettingsStory();
    return (
      <StoryFrame>
        <TunnelSettings tunnel={{ kind: 'quick' }} />
      </StoryFrame>
    );
  },
};

export const Named = {
  render: () => {
    seedSettingsStory();
    return (
      <StoryFrame>
        <TunnelSettings
          tunnel={{
            kind: 'named',
            hostname: 'cockpit.example.invalid',
            name: 'development',
            tokenFile: '/workspace/tunnel-token',
          }}
        />
      </StoryFrame>
    );
  },
};
