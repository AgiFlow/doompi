import { StoryFrame } from '../../components/Story.fixture.tsx';
import { ImageSettings } from './ImageSettings.tsx';
import { seedSettingsStory } from './settings.fixture.ts';

const meta = { title: 'Web/ImageSettings', component: ImageSettings, tags: ['style-system'] };
export default meta;

export const Playground = {
  render: () => {
    seedSettingsStory();
    return (
      <StoryFrame>
        <ImageSettings />
      </StoryFrame>
    );
  },
};

export const ResizeDisabled = {
  render: () => {
    seedSettingsStory({
      'GET /api/settings/images': {
        autoResize: false,
        maxDimension: 1568,
        minDimension: 256,
        maxAllowedDimension: 2048,
      },
    });
    return (
      <StoryFrame>
        <ImageSettings />
      </StoryFrame>
    );
  },
};

export const Unavailable = {
  render: () => {
    seedSettingsStory({
      'GET /api/settings/images': Response.json({ error: 'Image settings could not be read.' }, { status: 503 }),
    });
    return (
      <StoryFrame>
        <ImageSettings />
      </StoryFrame>
    );
  },
};
