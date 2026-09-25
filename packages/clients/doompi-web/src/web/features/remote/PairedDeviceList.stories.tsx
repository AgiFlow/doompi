import { remoteView, seedRemoteStory } from '../../components/Remote.fixture.tsx';
import { StoryFrame } from '../../components/Story.fixture.tsx';
import { PairedDeviceList } from './PairedDeviceList.tsx';

const meta = { title: 'Web/Remote/PairedDeviceList', component: PairedDeviceList, tags: ['style-system'] };
export default meta;

export const Playground = {
  render: () => {
    seedRemoteStory({
      view: {
        ...remoteView,
        devices: [
          ...remoteView.devices,
          {
            id: 'story-self',
            label: 'This browser',
            userAgent: 'Example desktop browser',
            self: true,
            createdAt: '2026-09-01T10:00:00.000Z',
            lastSeenAt: '2026-09-01T10:00:00.000Z',
          },
        ],
      },
    });
    return (
      <StoryFrame>
        <PairedDeviceList />
      </StoryFrame>
    );
  },
};
