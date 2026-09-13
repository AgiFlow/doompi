import { sealedTransport } from '@agimon-ai/doompi-web-security/browser';

import type { SubagentCatalogAgent, SubagentCatalogPayload } from '../../types/webSubagents';
import type { LaunchRequest } from '../lib/launchCommand';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isStrings(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === 'string');
}

function isAgent(value: unknown): value is SubagentCatalogAgent {
  return (
    isRecord(value) &&
    typeof value.name === 'string' &&
    typeof value.description === 'string' &&
    typeof value.filePath === 'string' &&
    ['project', 'user', 'plugin'].includes(String(value.source)) &&
    (value.packageName === undefined || typeof value.packageName === 'string') &&
    (value.model === undefined || typeof value.model === 'string') &&
    isStrings(value.fallbackModels) &&
    isStrings(value.tools) &&
    isStrings(value.skills) &&
    isStrings(value.extensions) &&
    (value.defaultContext === 'fresh' || value.defaultContext === 'fork')
  );
}

/** Read the selected session's catalog through the host's authenticated HTTP transport. */
export async function fetchCatalog(sessionId: string, signal: AbortSignal): Promise<SubagentCatalogPayload> {
  const response = await sealedTransport.fetch(`/api/sessions/${encodeURIComponent(sessionId)}/plugin/team/catalog`, {
    signal,
    cache: 'no-store',
  });
  const body: unknown = await response.json();
  if (!response.ok) {
    throw new Error(
      isRecord(body) && typeof body.error === 'string'
        ? body.error
        : `Agent catalog could not be loaded (${response.status}).`,
    );
  }
  if (
    !isRecord(body) ||
    typeof body.cwd !== 'string' ||
    !Array.isArray(body.agents) ||
    !body.agents.every(isAgent) ||
    !isStrings(body.models)
  ) {
    throw new Error('The server returned an invalid agent catalog.');
  }
  return { cwd: body.cwd, agents: body.agents, models: body.models };
}

/** Launch on the selected session host, without submitting a parent prompt. */
export async function launchAgent(sessionId: string, request: LaunchRequest): Promise<string> {
  const response = await sealedTransport.fetch(`/api/sessions/${encodeURIComponent(sessionId)}/plugin/team/run`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(request),
  });
  const body: unknown = await response.json();
  if (!response.ok) {
    throw new Error(
      isRecord(body) && typeof body.error === 'string'
        ? body.error
        : `Agent could not be launched (${response.status}).`,
    );
  }
  if (!isRecord(body) || typeof body.runId !== 'string' || body.runId === '')
    throw new Error('The server returned an invalid run ID.');
  return body.runId;
}
