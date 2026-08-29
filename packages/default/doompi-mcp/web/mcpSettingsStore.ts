import { Store } from '@tanstack/store';
import type { McpAuthorizationFlow, McpRepositoryCatalog } from '../src/types/webMcp.ts';
import {
  cancelMcpAuthorization,
  discoverMcpCatalog,
  type McpRequest,
  readMcpAuthorization,
  readMcpCatalog,
  startMcpAuthorization,
} from './mcpSettingsApi.ts';

export interface McpSettingsState {
  repositoryId: string | undefined;
  catalog: McpRepositoryCatalog | undefined;
  authorization: McpAuthorizationFlow | undefined;
  busy: 'loading' | 'discovering' | 'authorizing' | 'cancelling' | undefined;
  error: string | undefined;
}

export const mcpSettings = new Store<McpSettingsState>({
  repositoryId: undefined,
  catalog: undefined,
  authorization: undefined,
  busy: undefined,
  error: undefined,
});

function selectRepository(repositoryId: string): void {
  if (mcpSettings.state.repositoryId === repositoryId) return;
  mcpSettings.setState(() => ({
    repositoryId,
    catalog: undefined,
    authorization: undefined,
    busy: undefined,
    error: undefined,
  }));
}

function applyFor(repositoryId: string, update: (current: McpSettingsState) => McpSettingsState): void {
  if (mcpSettings.state.repositoryId !== repositoryId) return;
  mcpSettings.setState(update);
}

export async function loadMcpSettings(request: McpRequest, repositoryId: string): Promise<void> {
  selectRepository(repositoryId);
  mcpSettings.setState((current) => ({ ...current, busy: 'loading', error: undefined }));
  try {
    const result = await readMcpCatalog(request, repositoryId);
    applyFor(repositoryId, (current) =>
      'error' in result
        ? { ...current, busy: undefined, error: result.error }
        : { ...current, busy: undefined, catalog: result.value, error: undefined },
    );
  } catch {
    applyFor(repositoryId, (current) => ({ ...current, busy: undefined, error: 'The cockpit hub is unreachable.' }));
  }
}

export async function discoverMcpSettings(requestWithStepUp: McpRequest, repositoryId: string): Promise<void> {
  selectRepository(repositoryId);
  mcpSettings.setState((current) => ({ ...current, busy: 'discovering', error: undefined }));
  try {
    const result = await discoverMcpCatalog(requestWithStepUp, repositoryId);
    applyFor(repositoryId, (current) =>
      'error' in result
        ? { ...current, busy: undefined, error: result.error }
        : { ...current, busy: undefined, catalog: result.value, error: undefined },
    );
  } catch {
    applyFor(repositoryId, (current) => ({ ...current, busy: undefined, error: 'The cockpit hub is unreachable.' }));
  }
}

export async function authorizeMcpServer(
  requestWithStepUp: McpRequest,
  repositoryId: string,
  serverName: string,
): Promise<void> {
  selectRepository(repositoryId);
  mcpSettings.setState((current) => ({ ...current, busy: 'authorizing', error: undefined }));
  try {
    const result = await startMcpAuthorization(requestWithStepUp, repositoryId, serverName);
    applyFor(repositoryId, (current) =>
      'error' in result
        ? { ...current, busy: undefined, error: result.error }
        : { ...current, busy: undefined, authorization: result.value, error: undefined },
    );
  } catch {
    applyFor(repositoryId, (current) => ({ ...current, busy: undefined, error: 'The cockpit hub is unreachable.' }));
  }
}

export function followMcpAuthorization(
  request: McpRequest,
  repositoryId: string,
  flowId: string,
  onCompleted: () => void,
): () => void {
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const poll = async (): Promise<void> => {
    if (stopped) return;
    try {
      const result = await readMcpAuthorization(request, repositoryId, flowId);
      if (stopped) return;
      if ('error' in result) {
        applyFor(repositoryId, (current) => ({ ...current, error: result.error }));
        return;
      }
      applyFor(repositoryId, (current) => ({ ...current, authorization: result.value, error: undefined }));
      if (result.value.status === 'completed') {
        onCompleted();
        return;
      }
      if (['failed', 'cancelled', 'expired'].includes(result.value.status)) return;
      timer = setTimeout(() => void poll(), 1000);
    } catch {
      applyFor(repositoryId, (current) => ({ ...current, error: 'The authorization status could not be refreshed.' }));
    }
  };
  void poll();
  return () => {
    stopped = true;
    if (timer) clearTimeout(timer);
  };
}

export async function cancelMcpFlow(
  requestWithStepUp: McpRequest,
  repositoryId: string,
  flowId: string,
): Promise<void> {
  mcpSettings.setState((current) => ({ ...current, busy: 'cancelling', error: undefined }));
  try {
    const result = await cancelMcpAuthorization(requestWithStepUp, repositoryId, flowId);
    applyFor(repositoryId, (current) =>
      'error' in result
        ? { ...current, busy: undefined, error: result.error }
        : { ...current, busy: undefined, authorization: result.value, error: undefined },
    );
  } catch {
    applyFor(repositoryId, (current) => ({ ...current, busy: undefined, error: 'The cockpit hub is unreachable.' }));
  }
}
