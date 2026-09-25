import type { LoginFlowSnapshot } from '../../../types/auth.ts';
import { StoryFrame } from '../../components/Story.fixture.tsx';
import { LoginFlowDialog } from './LoginFlowDialog.tsx';
import { seedSettingsStory } from './settings.fixture.ts';

const meta = { title: 'Web/LoginFlowDialog', component: LoginFlowDialog, tags: ['style-system'] };
export default meta;

const flow: LoginFlowSnapshot = {
  id: 'story-login',
  providerId: 'example',
  providerName: 'Example provider',
  type: 'api_key',
  status: 'running',
  events: [],
};

export const Playground = {
  render: () => {
    seedSettingsStory();
    return (
      <StoryFrame>
        <LoginFlowDialog
          flow={{
            ...flow,
            prompt: { id: 'key', type: 'secret', message: 'Enter an API key', placeholder: 'Example key' },
          }}
          onAnswer={() => undefined}
          onCancel={() => undefined}
          onClose={() => undefined}
        />
      </StoryFrame>
    );
  },
};

export const DeviceCode = {
  render: () => {
    seedSettingsStory();
    return (
      <StoryFrame>
        <LoginFlowDialog
          flow={{
            ...flow,
            type: 'oauth',
            events: [{ type: 'device_code', userCode: 'ABCD-EFGH', verificationUri: 'https://example.invalid/device' }],
          }}
          onAnswer={() => undefined}
          onCancel={() => undefined}
          onClose={() => undefined}
        />
      </StoryFrame>
    );
  },
};

export const Failed = {
  render: () => {
    seedSettingsStory();
    return (
      <StoryFrame>
        <LoginFlowDialog
          flow={{ ...flow, status: 'failed', error: 'Authorization expired. Start again to request a new code.' }}
          onAnswer={() => undefined}
          onCancel={() => undefined}
          onClose={() => undefined}
        />
      </StoryFrame>
    );
  },
};
