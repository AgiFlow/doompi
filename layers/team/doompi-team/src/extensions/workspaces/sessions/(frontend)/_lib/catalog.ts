import { sessionApiPath } from '@agimon-ai/doompi-core/web';
import { sealedTransport } from '@agimon-ai/doompi-web-security/browser';

import type {
  SubagentCatalogAgent,
  SubagentCatalogPayload,
  SubagentSteerResult,
} from '../../../../../types/webSubagents';
import type { LaunchRequest } from './launchCommand';

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
  const response = await sealedTransport.fetch(`${sessionApiPath(sessionId)}/plugins/team/catalog`, {
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
  const response = await sealedTransport.fetch(`${sessionApiPath(sessionId)}/plugins/team/run`, {
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

function isSteerState(value: unknown): value is SubagentSteerResult['state'] {
  return value === 'delivered' || value === 'failed' || value === 'pending';
}

/** Steer one run on the selected session host, without submitting a parent prompt. */
export async function steerRun(sessionId: string, runId: string, message: string): Promise<SubagentSteerResult> {
  const response = await sealedTransport.fetch(`${sessionApiPath(sessionId)}/plugins/team/steer`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ runId, message }),
  });
  const body: unknown = await response.json();
  if (!response.ok) {
    throw new Error(
      isRecord(body) && typeof body.error === 'string'
        ? body.error
        : `Guidance could not be sent (${response.status}).`,
    );
  }
  if (!isRecord(body) || !isSteerState(body.state) || typeof body.message !== 'string')
    throw new Error('The server returned an invalid steer result.');
  return { state: body.state, message: body.message };
}

/** Ask the selected session host to stop one run; the run's own status reports when it has. */
export async function stopRun(sessionId: string, runId: string): Promise<void> {
  const response = await sealedTransport.fetch(`${sessionApiPath(sessionId)}/plugins/team/stop`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ runId }),
  });
  const body: unknown = await response.json();
  if (!response.ok) {
    throw new Error(
      isRecord(body) && typeof body.error === 'string'
        ? body.error
        : `The run could not be stopped (${response.status}).`,
    );
  }
}
