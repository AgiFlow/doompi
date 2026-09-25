import { seedRemoteStory } from '../../components/Remote.fixture.tsx';
import { StoryFrame } from '../../components/Story.fixture.tsx';
import { RemoteAccessPairing } from './RemoteAccessPairing.tsx';

const meta = { title: 'Web/Remote/RemoteAccessPairing', component: RemoteAccessPairing, tags: ['style-system'] };
export default meta;

export const Playground = {
  render: () => {
    seedRemoteStory({ step: 'pairing' });
    return (
      <StoryFrame>
        <RemoteAccessPairing />
      </StoryFrame>
    );
  },
};
export const PasskeysUnavailable = {
  render: () => {
    seedRemoteStory({
      passkeys: {
        supported: false,
        count: 0,
        reason: 'Passkeys require a supported browser and a stable tunnel hostname.',
      },
    });
    return (
      <StoryFrame>
        <RemoteAccessPairing />
      </StoryFrame>
    );
  },
};
