import { Badge } from '@agimon-ai/doompi-web-components';

import { StoryFrame } from '../../components/Story.fixture.tsx';
import { seedSettingsStory } from './settings.fixture.ts';
import { SettingsSectionHeader } from './SettingsSectionHeader.tsx';

const meta = { title: 'Web/SettingsSectionHeader', component: SettingsSectionHeader, tags: ['style-system'] };
export default meta;

export const Playground = {
  render: () => {
    seedSettingsStory();
    return (
      <StoryFrame>
        <div className="flex flex-col gap-6">
          <SettingsSectionHeader
            title="Appearance"
            detail="Choose a theme and layout. Longer explanatory text should wrap naturally without crowding the status badge."
          >
            <Badge tone="yellow">unsaved</Badge>
          </SettingsSectionHeader>
          <SettingsSectionHeader title="Providers" />
        </div>
      </StoryFrame>
    );
  },
};
