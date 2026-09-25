import { remoteView, seedRemoteStory } from '../../components/Remote.fixture.tsx';
import { StoryFrame } from '../../components/Story.fixture.tsx';
import { RemoteAccessOptions } from './RemoteAccessOptions.tsx';

const meta = { title: 'Web/Remote/RemoteAccessOptions', component: RemoteAccessOptions, tags: ['style-system'] };
export default meta;

export const Playground = {
  render: () => {
    seedRemoteStory();
    return (
      <StoryFrame>
        <RemoteAccessOptions />
      </StoryFrame>
    );
  },
};
export const DisabledLimits = {
  render: () => {
    seedRemoteStory({
      view: {
        ...remoteView,
        devices: [],
        settings: {
          ...remoteView.settings,
          autoCloseEnabled: false,
          sessionExpiryEnabled: false,
          sandbox: { enabled: false, workspaces: [] },
        },
      },
    });
    return (
      <StoryFrame>
        <RemoteAccessOptions />
      </StoryFrame>
    );
  },
};
