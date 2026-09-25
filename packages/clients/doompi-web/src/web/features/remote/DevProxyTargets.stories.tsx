import { seedRemoteStory } from '../../components/Remote.fixture.tsx';
import { StoryFrame } from '../../components/Story.fixture.tsx';
import { DevProxyTargets } from './DevProxyTargets.tsx';

const meta = { title: 'Web/Remote/DevProxyTargets', component: DevProxyTargets, tags: ['style-system'] };
export default meta;

export const Playground = {
  render: () => {
    seedRemoteStory();
    return (
      <StoryFrame>
        <DevProxyTargets />
      </StoryFrame>
    );
  },
};
export const PairedDevice = {
  render: () => {
    seedRemoteStory({}, { canRegister: false });
    return (
      <StoryFrame>
        <DevProxyTargets />
      </StoryFrame>
    );
  },
};
export const Empty = {
  render: () => {
    seedRemoteStory({}, { targets: [] });
    return (
      <StoryFrame>
        <DevProxyTargets />
      </StoryFrame>
    );
  },
};
