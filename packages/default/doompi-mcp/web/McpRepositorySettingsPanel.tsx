import { Badge, Button } from '@agimon-ai/doompi-web-components';
import type { RepositorySettingsPanelProps } from '@agimon-ai/doompi-web-contracts';
import { useStore } from '@tanstack/react-store';
import { useEffect, useState } from 'react';
import {
  authorizeMcpServer,
  cancelMcpFlow,
  discoverMcpSettings,
  followMcpAuthorization,
  loadMcpSettings,
  mcpSettings,
} from './mcpSettingsStore.ts';

const TERMINAL_AUTHORIZATION = new Set(['completed', 'failed', 'cancelled', 'expired']);

function syncReason(reason: string): string {
  const labels: Record<string, string> = {
    'never-synced': 'never synced',
    'configuration-changed': 'configuration changed',
    'cockpit-bundle-missing': 'cockpit bundle missing',
    'package-apis-missing': 'package APIs missing',
  };
  return labels[reason] ?? reason;
}

export function McpRepositorySettingsPanel({ repository, request, requestWithStepUp }: RepositorySettingsPanelProps) {
  const state = useStore(mcpSettings);
  const [confirmDiscovery, setConfirmDiscovery] = useState(false);
  const [confirmAuthorization, setConfirmAuthorization] = useState<string | undefined>();
  const repositoryId = repository?.id;

  useEffect(() => {
    setConfirmDiscovery(false);
    setConfirmAuthorization(undefined);
    if (repositoryId) void loadMcpSettings(request, repositoryId);
  }, [repositoryId, request]);

  const authorization = state.repositoryId === repositoryId ? state.authorization : undefined;
  useEffect(() => {
    if (!repositoryId || !authorization || TERMINAL_AUTHORIZATION.has(authorization.status)) return;
    return followMcpAuthorization(request, repositoryId, authorization.id, () => {
      void loadMcpSettings(request, repositoryId);
    });
  }, [authorization?.id, authorization?.status, repositoryId, request]);

  if (!repository) {
    return <p className="py-3 text-[10px] text-doom-faint">Select a repository to inspect its synced MCP catalog.</p>;
  }

  const catalog = state.repositoryId === repository.id ? state.catalog : undefined;
  const busy = state.repositoryId === repository.id ? state.busy : undefined;
  const error = state.repositoryId === repository.id ? state.error : undefined;

  return (
    <div className="flex flex-col gap-3" data-testid="mcp-repository-settings">
      <div className="flex flex-wrap items-center gap-2 rounded border border-doom-border bg-doom-panel px-3 py-2">
        <Badge>{catalog?.sync.fresh ? 'synced' : 'sync required'}</Badge>
        <span className="min-w-0 flex-1 text-[10px] text-doom-muted">
          {catalog?.sync.fresh
            ? 'Cached inspection is local. Discovery contacts the configured servers.'
            : catalog
              ? catalog.sync.reasons.map(syncReason).join(', ')
              : 'Reading the last synced projection.'}
        </span>
        <Button
          variant="outline"
          size="xs"
          loading={busy === 'loading'}
          disabled={busy !== undefined}
          onClick={() => void loadMcpSettings(request, repository.id)}
          className="text-[10px]"
        >
          refresh cache
        </Button>
        <Button
          variant="outline"
          size="xs"
          loading={busy === 'discovering'}
          disabled={busy !== undefined || !catalog?.sync.fresh}
          onClick={() => setConfirmDiscovery(true)}
          className="text-[10px]"
        >
          discover live
        </Button>
      </div>

      {!confirmDiscovery ? null : (
        <div className="flex flex-wrap items-center gap-2 rounded border border-doom-accent/50 bg-doom-accent/5 px-3 py-2">
          <span className="min-w-0 flex-1 text-[10px] text-doom-hi">
            Discovery starts configured processes and contacts remote MCP servers. Continue?
          </span>
          <Button
            size="xs"
            disabled={busy !== undefined}
            onClick={() => {
              setConfirmDiscovery(false);
              void discoverMcpSettings(requestWithStepUp, repository.id);
            }}
            className="text-[10px]"
          >
            confirm discovery
          </Button>
          <Button variant="ghost" size="xs" onClick={() => setConfirmDiscovery(false)} className="text-[10px]">
            cancel
          </Button>
        </div>
      )}

      {!error ? null : <p className="rounded border border-doom-red/40 px-3 py-2 text-[10px] text-doom-red">{error}</p>}

      {authorization ? (
        <div className="flex flex-col gap-2 rounded border border-doom-border bg-doom-panel px-3 py-2">
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-[10px] font-bold text-doom-hi">{authorization.serverName}</span>
            <Badge>{authorization.status}</Badge>
            <span className="min-w-0 flex-1 text-[9px] text-doom-faint">authorization flow</span>
            {TERMINAL_AUTHORIZATION.has(authorization.status) ? null : (
              <Button
                variant="ghost"
                size="xs"
                loading={busy === 'cancelling'}
                disabled={busy !== undefined}
                onClick={() => void cancelMcpFlow(requestWithStepUp, repository.id, authorization.id)}
                className="text-[10px]"
              >
                cancel
              </Button>
            )}
          </div>
          {!authorization.authorizationUrl ? null : (
            <a
              href={authorization.authorizationUrl}
              target="_blank"
              rel="noreferrer noopener"
              className="w-fit text-[10px] text-doom-accent underline underline-offset-2"
            >
              open authorization page
            </a>
          )}
          {!authorization.error ? null : <p className="text-[9px] text-doom-red">{authorization.error}</p>}
        </div>
      ) : null}

      {!catalog || catalog.servers.length === 0 ? (
        <p className="rounded border border-dashed border-doom-border px-3 py-4 text-[10px] text-doom-faint">
          {busy === 'loading' ? 'Reading the cached catalog.' : 'No MCP servers are enabled in the synced selection.'}
        </p>
      ) : (
        <div className="flex flex-col gap-2">
          {catalog.servers.map((server) => (
            <div
              key={server.name}
              className="flex flex-col gap-2 rounded border border-doom-border bg-doom-panel px-3 py-2"
            >
              <div className="flex flex-wrap items-center gap-2">
                <span className="min-w-0 flex-1 truncate text-[11px] font-bold text-doom-hi">{server.name}</span>
                <Badge>{server.state}</Badge>
                <Badge>{server.source}</Badge>
                <Badge>{server.credentialPresent ? 'credential present' : 'no credential'}</Badge>
                <Button
                  variant="outline"
                  size="xs"
                  disabled={busy !== undefined || !catalog.sync.fresh}
                  onClick={() => setConfirmAuthorization(server.name)}
                  className="text-[10px]"
                >
                  authorize
                </Button>
              </div>
              {confirmAuthorization !== server.name ? null : (
                <div className="flex flex-wrap items-center gap-2 border-t border-doom-border pt-2">
                  <span className="min-w-0 flex-1 text-[9px] text-doom-muted">
                    Start a bounded OAuth attempt for this server? A passkey may be required.
                  </span>
                  <Button
                    size="xs"
                    disabled={busy !== undefined}
                    onClick={() => {
                      setConfirmAuthorization(undefined);
                      void authorizeMcpServer(requestWithStepUp, repository.id, server.name);
                    }}
                    className="text-[10px]"
                  >
                    continue
                  </Button>
                  <Button
                    variant="ghost"
                    size="xs"
                    onClick={() => setConfirmAuthorization(undefined)}
                    className="text-[10px]"
                  >
                    cancel
                  </Button>
                </div>
              )}
              <details>
                <summary className="cursor-pointer text-[9px] text-doom-muted">
                  {String(server.tools.length)} cached {server.tools.length === 1 ? 'tool' : 'tools'}
                </summary>
                <div className="mt-2 flex flex-col gap-1 border-t border-doom-border pt-2">
                  {server.tools.length === 0 ? (
                    <span className="text-[9px] text-doom-faint">Run discovery to populate capabilities.</span>
                  ) : (
                    server.tools.map((tool) => (
                      <div key={tool.piName} className="flex min-w-0 gap-2 text-[9px]">
                        <code className="shrink-0 text-doom-hi">{tool.name}</code>
                        <span className="truncate text-doom-faint">{tool.description ?? tool.piName}</span>
                      </div>
                    ))
                  )}
                </div>
              </details>
              {!server.error ? null : <p className="text-[9px] text-doom-red">{server.error}</p>}
            </div>
          ))}
        </div>
      )}

      {catalog?.droppedServers.length ? (
        <p className="text-[9px] text-doom-faint">
          Policy omitted {String(catalog.droppedServers.length)} configured servers.
        </p>
      ) : null}
      {catalog?.diagnostics.map((diagnostic) => (
        <p key={diagnostic} className="text-[9px] text-doom-red">
          {diagnostic}
        </p>
      ))}
    </div>
  );
}
