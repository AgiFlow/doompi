import { remoteView, seedRemoteStory } from '../../components/Remote.fixture.tsx';
import { StoryFrame } from '../../components/Story.fixture.tsx';
import { PairingApprovalDialog } from './PairingApprovalDialog.tsx';

const meta = { title: 'Web/Remote/PairingApprovalDialog', component: PairingApprovalDialog, tags: ['style-system'] };
export default meta;

export const Playground = {
  render: () => {
    seedRemoteStory({
      view: {
        ...remoteView,
        pending: [
          {
            id: 'story-pairing',
            userAgent: 'Example mobile browser with a long device identification string',
            edgeIp: '192.0.2.10',
            createdAt: '2026-09-01T10:00:00.000Z',
            expiresAt: '2026-09-01T10:03:00.000Z',
          },
        ],
      },
    });
    return (
      <StoryFrame>
        <PairingApprovalDialog />
      </StoryFrame>
    );
  },
};
