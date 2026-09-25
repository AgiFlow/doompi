import { StoryFrame } from '../../components/Story.fixture.tsx';
import { HandoverProgress } from './HandoverProgress.tsx';

const meta = { title: 'Web/Remote/HandoverProgress', component: HandoverProgress, tags: ['style-system'] };
export default meta;

export const Playground = {
  render: () => (
    <StoryFrame>
      <HandoverProgress />
    </StoryFrame>
  ),
};
