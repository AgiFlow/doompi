import type { SettingsSectionContribution } from '@agimon-ai/doompi-core/web';

import type { ProviderAuthSummary } from '../../../types/auth.ts';
import type { SessionMcpClient, SessionMcpConfig } from '../../../types/sessionMcp.ts';
import type { RepositorySettingsView, SettingsConfigView, SettingsRepository } from '../../../types/settings.ts';
import { remoteView, seedRemoteStory } from '../../components/Remote.fixture.tsx';
import {
  mockStoryRequests,
  seedStorySession,
  STORY_SESSION_ID,
  STORY_WORKSPACE_ID,
} from '../../components/Story.fixture.tsx';
import { seedTemplateStory, templateConfig } from '../../components/Template.fixture.tsx';

export const repository: SettingsRepository = {
  id: STORY_WORKSPACE_ID,
  name: 'doompi',
  path: '/workspace/doompi',
  active: true,
};

export const section: SettingsSectionContribution = {
  id: 'story-settings',
  label: 'Agent defaults',
  detail: 'Review editable, inherited, and read-only values before saving.',
  fields: [
    {
      id: 'name',
      label: 'Session name',
      kind: 'text',
      keyPath: ['review', 'name'],
      detail: 'A descriptive name for a new review.',
    },
    { id: 'limit', label: 'Iteration limit', kind: 'number', keyPath: ['review', 'limit'] },
    { id: 'enabled', label: 'Enable review', kind: 'toggle', keyPath: ['review', 'enabled'] },
    {
      id: 'model',
      label: 'Model',
      kind: 'select',
      keyPath: ['review', 'model'],
      options: [
        { value: 'local', label: 'Local model' },
        { value: 'remote', label: 'Remote model' },
      ],
    },
    { id: 'source', label: 'Configuration source', kind: 'info', keyPath: ['review', 'source'] },
  ],
};

export const config: SettingsConfigView = {
  ...templateConfig,
  values: {
    ...templateConfig.values,
    'review.name': { value: 'Component review', origin: 'global', scope: 'both' },
    'review.limit': { value: '5', origin: 'default', scope: 'both' },
    'review.enabled': { value: 'true', origin: 'global', scope: 'both' },
    'review.model': { value: 'local', origin: 'repository', scope: 'both' },
    'review.source': { value: 'Machine configuration', origin: 'global', scope: 'global' },
  },
};

export const repositorySettings: RepositorySettingsView = {
  repository,
  hash: 'story-repository',
  catalogs: {
    majorModes: [
      { name: 'copilot', description: 'Interactive development' },
      { name: 'review', description: 'Source review' },
    ],
    domains: [{ name: 'development' }, { name: 'testing' }],
    profiles: [{ name: 'ponytail' }, { name: 'reviewer' }],
  },
  selection: {
    majorMode: { effective: 'copilot', origin: 'global' },
    domains: { effective: ['development', 'testing'], repository: ['development', 'testing'], origin: 'repository' },
    profile: { effective: 'ponytail', origin: 'default' },
  },
};

export const providers: ProviderAuthSummary[] = [
  {
    id: 'example-key',
    name: 'Example API provider',
    methods: [{ type: 'api_key', label: 'API key' }],
    authenticated: { type: 'api_key', source: 'stored' },
  },
  {
    id: 'example-oauth',
    name: 'Example OAuth provider',
    methods: [
      { type: 'oauth', label: 'Browser sign-in' },
      { type: 'api_key', label: 'API key' },
    ],
  },
];

export const mcpRoute = `/api/workspaces/${STORY_WORKSPACE_ID}/sessions/${STORY_SESSION_ID}/mcp`;
export const mcpConfig: SessionMcpConfig = {
  audience: 'https://example.invalid/mcp/story-session',
  authorizationEndpoint: 'https://example.invalid/oauth/authorize',
  tokenEndpoint: 'https://example.invalid/oauth/token',
  tools: [{ name: 'read', label: 'Read file', description: 'Read a file in the selected workspace.' }],
  skills: [{ name: 'style-system', description: 'Render component stories.', uri: 'skill://style-system' }],
};
export const mcpClient: SessionMcpClient = {
  clientId: 'story-client',
  name: 'Component review client',
  redirectUri: '',
  tokenEndpointAuthMethod: 'api_key',
  createdAt: 0,
  scope: 'session',
  routing: 'conversation',
  tools: ['read'],
  skills: ['style-system'],
  audience: mcpConfig.audience,
};

export function seedSettingsStory(responses: Readonly<Record<string, unknown>> = {}): void {
  seedStorySession();
  seedTemplateStory();
  seedRemoteStory();
  mockStoryRequests({
    'GET /api/settings': config,
    [`GET /api/workspaces/${STORY_WORKSPACE_ID}/settings`]: config,
    'GET /api/settings/repositories': { repositories: [repository] },
    [`GET /api/workspaces/${STORY_WORKSPACE_ID}/settings/repository`]: repositorySettings,
    'GET /api/settings/images': { autoResize: true, maxDimension: 1568, minDimension: 256, maxAllowedDimension: 2048 },
    'GET /api/plugins/doompi/providers': { providers },
    'GET /api/remote': remoteView,
    'GET /api/remote/state': remoteView,
    [`GET ${mcpRoute}/config`]: mcpConfig,
    [`GET ${mcpRoute}/clients`]: { clients: [mcpClient] },
    ...responses,
  });
}
