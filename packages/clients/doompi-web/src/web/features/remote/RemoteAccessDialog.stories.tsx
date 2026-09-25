import { remoteView, seedRemoteStory } from '../../components/Remote.fixture.tsx';
import { StoryFrame } from '../../components/Story.fixture.tsx';
import { RemoteAccessDialog } from './RemoteAccessDialog.tsx';

const meta = { title: 'Web/Remote/RemoteAccessDialog', component: RemoteAccessDialog, tags: ['style-system'] };
export default meta;

export const Playground = {
  render: () => {
    seedRemoteStory();
    return (
      <StoryFrame>
        <RemoteAccessDialog />
      </StoryFrame>
    );
  },
};
export const Pairing = {
  render: () => {
    seedRemoteStory({ step: 'pairing', view: { ...remoteView, status: 'on' } });
    return (
      <StoryFrame>
        <RemoteAccessDialog />
      </StoryFrame>
    );
  },
};
export const Handover = {
  render: () => {
    seedRemoteStory({ step: 'handover' });
    return (
      <StoryFrame>
        <RemoteAccessDialog />
      </StoryFrame>
    );
  },
};
export const Failure = {
  render: () => {
    seedRemoteStory({ error: 'The tunnel could not start. Check the host connection and try again.' });
    return (
      <StoryFrame>
        <RemoteAccessDialog />
      </StoryFrame>
    );
  },
};
