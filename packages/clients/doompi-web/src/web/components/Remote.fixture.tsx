import { DEV_PROXY_TARGETS_ROUTE } from '../../types/devProxy.ts';
import type { RemoteAccessStateView } from '../../types/remoteAccess.ts';
import { devProxyStore, type DevProxyState } from '../stores/devProxyStore.ts';
import { remoteAccessStore, type RemoteAccessState } from '../stores/remoteAccessStore.ts';
import { mockStoryRequests } from './Story.fixture.tsx';

export const remoteView: RemoteAccessStateView = {
  status: 'off',
  devices: [
    {
      id: 'story-device',
      label: 'A paired phone with a long descriptive name',
      userAgent: 'Example mobile browser on a personal phone',
      createdAt: '2026-09-01T10:00:00.000Z',
      lastSeenAt: '2026-09-01T10:00:00.000Z',
      self: false,
    },
  ],
  pending: [],
  settings: {
    autoCloseEnabled: true,
    autoCloseMinutes: 30,
    sessionExpiryEnabled: true,
    idleMinutes: 15,
    absoluteHours: 24,
    tunnel: { kind: 'quick' },
    sandbox: { enabled: true, workspaces: ['/workspace/doompi'] },
  },
};

export function seedRemoteStory(patch: Partial<RemoteAccessState> = {}, proxyPatch: Partial<DevProxyState> = {}): void {
  const proxy: DevProxyState = {
    targets: [{ name: 'component-preview', port: 3000, createdAt: 0 }],
    canRegister: true,
    busy: false,
    ...proxyPatch,
  };
  mockStoryRequests({ [`GET ${DEV_PROXY_TARGETS_ROUTE}`]: { targets: proxy.targets, canRegister: proxy.canRegister } });
  devProxyStore.setState(() => proxy);
  remoteAccessStore.setState(() => ({
    step: 'options',
    busy: false,
    view: remoteView,
    pairUrl: 'https://example.invalid/pair#story-only',
    pairCode: 'STORY-CODE',
    pairFingerprint: '0123456789abcdef0123456789abcdef',
    pairRevision: 1,
    passkeys: { supported: true, count: 0 },
    ...patch,
  }));
}
