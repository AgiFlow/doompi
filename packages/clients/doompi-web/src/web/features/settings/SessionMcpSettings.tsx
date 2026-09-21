import {
  Badge,
  Button,
  Input,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Spinner,
} from '@agimon-ai/doompi-web-components';
import { useStore } from '@tanstack/react-store';
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';

import type { CreatedSessionMcpClient, SessionMcpClient, SessionMcpConfig } from '../../../types/sessionMcp';
import { rememberedHostChannelKey } from '../../lib/sealedSession';
import {
  createSessionMcpClient,
  listSessionMcpClients,
  readSessionMcpConfig,
  revokeSessionMcpClient,
} from '../../lib/sessionMcpApi';
import { sessionsStore } from '../../stores/sessionsStore';

function exactHttpsUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && url.username === '' && url.password === '' && url.hash === '';
  } catch {
    return false;
  }
}

function withoutSecret(client: CreatedSessionMcpClient): SessionMcpClient {
  const { clientSecret: _clientSecret, ...metadata } = client;
  return metadata;
}

type CopyState = 'idle' | 'copied' | 'failed';

function CopyValue({ label, value, testId }: { label: string; value: string; testId: string }) {
  const [state, setState] = useState<CopyState>('idle');

  async function copy(): Promise<void> {
    if (navigator.clipboard === undefined) {
      setState('failed');
      return;
    }
    try {
      await navigator.clipboard.writeText(value);
      setState('copied');
    } catch {
      setState('failed');
    }
  }

  return (
    <div className="flex flex-col gap-1">
      <div className="flex items-center justify-between gap-2 text-xs text-doom-faint">
        <span>{label}</span>
        <Button
          type="button"
          variant="ghost"
          size="xs"
          data-testid={`${testId}-copy`}
          aria-label={`copy ${label}`}
          onClick={() => void copy()}
        >
          {state === 'copied' ? 'copied' : 'copy'}
        </Button>
      </div>
      <code className="break-all text-sm text-doom-text" data-testid={testId}>
        {value}
      </code>
      <output aria-live="polite" className="text-xs text-doom-faint">
        {state === 'failed'
          ? `copying ${label.toLowerCase()} was blocked. select the value above to copy it manually.`
          : ''}
        {state === 'copied' ? `${label} copied.` : ''}
      </output>
    </div>
  );
}

/** Local management for the inbound, session-bound MCP endpoint exposed by the host. */
export function SessionMcpSettings() {
  const sessions = useStore(sessionsStore);
  const liveSessions = useMemo(
    () => sessions.order.map((id) => sessions.byId[id]).filter((meta) => meta !== undefined && !meta.summary.dormant),
    [sessions.byId, sessions.order],
  );
  const [sessionId, setSessionId] = useState(() => sessions.activeId ?? liveSessions[0]?.summary.id ?? '');
  const selected = sessionId === '' ? undefined : sessions.byId[sessionId];
  const workspaceId = selected?.summary.workspaceId;
  const available = selected?.attach === 'attached' && workspaceId !== undefined;
  const selectionKey = `${workspaceId ?? ''}\u0000${sessionId}`;
  const selectionKeyRef = useRef(selectionKey);
  useLayoutEffect(() => {
    selectionKeyRef.current = selectionKey;
  }, [selectionKey]);
  const remoteCaller = rememberedHostChannelKey() !== undefined;
  const [config, setConfig] = useState<SessionMcpConfig>();
  const [clients, setClients] = useState<SessionMcpClient[]>([]);
  const [redirectUri, setRedirectUri] = useState('');
  const [created, setCreated] = useState<{ sessionId: string; client: CreatedSessionMcpClient }>();
  const visibleCreated = created?.sessionId === sessionId ? created.client : undefined;
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();

  useEffect(() => {
    if (liveSessions.some((meta) => meta.summary.id === sessionId)) return;
    const next = liveSessions.find((meta) => meta.summary.id === sessions.activeId) ?? liveSessions[0];
    // eslint-disable-next-line react/set-state-in-effect -- a removed or ended session must move the management target.
    setSessionId(next?.summary.id ?? '');
  }, [liveSessions, sessionId, sessions.activeId]);

  useEffect(() => {
    let current = true;
    // All draft credentials are scoped to this selected runtime. In particular,
    // never let a one-time secret survive a selection change.
    // eslint-disable-next-line react/set-state-in-effect -- selection owns and resets this local credential draft.
    setCreated(undefined);
    setRedirectUri('');
    setConfig(undefined);
    setClients([]);
    setError(undefined);
    setBusy(false);
    if (!available || workspaceId === undefined) {
      setLoading(false);
      return () => {
        current = false;
      };
    }
    setLoading(true);
    void Promise.all([
      readSessionMcpConfig(workspaceId, sessionId),
      listSessionMcpClients(workspaceId, sessionId),
    ]).then(([configResult, clientsResult]) => {
      if (!current) return;
      if ('error' in configResult) setError(configResult.error);
      else setConfig(configResult.config);
      if ('error' in clientsResult) setError((previous) => previous ?? clientsResult.error);
      else setClients(clientsResult.clients);
      setLoading(false);
    });
    return () => {
      current = false;
    };
  }, [available, sessionId, workspaceId]);

  const invalidCallback = redirectUri !== '' && !exactHttpsUrl(redirectUri);
  const canCreate = available && !remoteCaller && config !== undefined && exactHttpsUrl(redirectUri) && !busy;

  async function createClient(): Promise<void> {
    if (!canCreate || workspaceId === undefined) return;
    const operationSelection = selectionKey;
    setBusy(true);
    setError(undefined);
    const result = await createSessionMcpClient(workspaceId, sessionId, {
      redirectUri: redirectUri.trim(),
      scope: 'session',
    });
    if (selectionKeyRef.current !== operationSelection) return;
    setBusy(false);
    if ('error' in result) {
      setError(result.error);
      return;
    }
    setCreated({ sessionId, client: result.client });
    setClients((current) => [withoutSecret(result.client), ...current]);
    setRedirectUri('');
  }

  async function revoke(clientId: string): Promise<void> {
    if (workspaceId === undefined) return;
    const operationSelection = selectionKey;
    setBusy(true);
    setError(undefined);
    const result = await revokeSessionMcpClient(workspaceId, sessionId, clientId);
    if (selectionKeyRef.current !== operationSelection) return;
    setBusy(false);
    if ('error' in result) {
      setError(result.error);
      return;
    }
    setClients((current) => current.filter((client) => client.clientId !== clientId));
    if (visibleCreated?.clientId === clientId) setCreated(undefined);
  }

  return (
    <section className="flex flex-col gap-4 border-t border-doom-border pt-5" data-testid="session-mcp-settings">
      <div className="flex flex-col gap-1">
        <h3 className="text-sm font-bold text-doom-hi">session MCP</h3>
        <p className="text-sm leading-relaxed text-doom-faint">
          connect one live DoomPi session to ChatGPT or another inbound MCP client. this is separate from outbound MCP
          servers, remote pairing, and remote control.
        </p>
      </div>

      <label htmlFor="session-mcp-picker" className="flex flex-col gap-1 text-sm text-doom-faint">
        live workspace / session
        <Select value={sessionId} disabled={liveSessions.length === 0} onValueChange={setSessionId}>
          <SelectTrigger id="session-mcp-picker" data-testid="session-mcp-session">
            <SelectValue placeholder="no live session available" />
          </SelectTrigger>
          <SelectContent>
            {liveSessions.map((meta) => (
              <SelectItem key={meta.summary.id} value={meta.summary.id}>
                {meta.summary.name} · {meta.summary.cwd}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </label>

      {selected === undefined ? (
        <p className="text-sm text-doom-faint">start a session before creating an MCP client.</p>
      ) : !available ? (
        <p className="text-sm text-doom-faint">
          this session is unavailable. reconnect it before creating an MCP client.
        </p>
      ) : loading ? (
        <p className="flex items-center gap-2 text-sm text-doom-faint">
          <Spinner label="loading session MCP configuration" />
          loading the session MCP connection…
        </p>
      ) : null}

      {error ? (
        <p role="alert" className="text-sm text-doom-red">
          {error}
        </p>
      ) : null}

      {selected !== undefined && available && !loading && config === undefined && error === undefined ? (
        <p className="text-sm text-doom-faint">
          enable Remote Control with a public HTTPS origin before using session MCP.
        </p>
      ) : null}

      {config === undefined ? null : (
        <div className="flex flex-col gap-3 rounded-md border border-doom-border bg-doom-deep p-3 text-sm">
          <CopyValue label="MCP URL" value={config.audience} testId="session-mcp-url" />
          <details>
            <summary className="cursor-pointer text-doom-faint">connection details</summary>
            <div className="mt-2 flex flex-col gap-1">
              <span className="text-xs text-doom-faint">authorization endpoint</span>
              <code className="break-all text-xs text-doom-text">{config.authorizationEndpoint}</code>
              <span className="mt-1 text-xs text-doom-faint">token endpoint</span>
              <code className="break-all text-xs text-doom-text">{config.tokenEndpoint}</code>
            </div>
          </details>
        </div>
      )}

      {config === undefined || remoteCaller ? null : (
        <div className="flex flex-col gap-3 rounded-md border border-doom-border p-3" data-testid="session-mcp-create">
          <div className="flex flex-col gap-1">
            <h4 className="text-sm font-bold text-doom-hi">connect this session to ChatGPT</h4>
            <p className="text-sm leading-relaxed text-doom-faint">
              In ChatGPT, choose <strong>User-Defined OAuth Client</strong>, copy its <strong>Callback URL</strong>, and
              paste it below.
            </p>
          </div>
          <label htmlFor="session-mcp-callback" className="flex flex-col gap-1 text-sm text-doom-faint">
            Callback URL from ChatGPT
            <Input
              id="session-mcp-callback"
              data-testid="session-mcp-callback"
              type="url"
              value={redirectUri}
              placeholder="https://chatgpt.com/connector/oauth/…"
              aria-invalid={invalidCallback}
              aria-describedby="session-mcp-callback-help"
              onChange={(event) => setRedirectUri(event.target.value)}
            />
          </label>
          <p id="session-mcp-callback-help" className="text-xs leading-relaxed text-doom-faint">
            Paste the exact HTTPS callback ChatGPT shows. DoomPi cannot generate this URL for you.
          </p>
          {invalidCallback ? (
            <p className="text-xs text-doom-red">
              use the exact absolute HTTPS callback without credentials or a fragment.
            </p>
          ) : null}
          <p className="text-xs leading-relaxed text-doom-faint">
            Access follows this session&apos;s current major mode, minor modes, domains, and profile, including future
            changes. Session tools run with the session&apos;s permissions.
          </p>
          <Button
            data-testid="session-mcp-create-button"
            loading={busy}
            disabled={!canCreate}
            onClick={() => void createClient()}
          >
            create OAuth client
          </Button>
        </div>
      )}

      {remoteCaller ? (
        <p className="text-sm text-doom-faint" data-testid="session-mcp-remote-note">
          client creation is available only from the host. existing metadata and revoke controls remain visible when the
          host permits remote management.
        </p>
      ) : null}

      {visibleCreated === undefined ? null : (
        <div
          className="flex flex-col gap-3 rounded-md border border-doom-blue/50 bg-doom-deep p-3"
          data-testid="session-mcp-secret"
        >
          <div className="flex items-center justify-between gap-2">
            <span className="text-sm font-bold text-doom-hi">save these connection details now</span>
            <Button variant="ghost" size="xs" onClick={() => setCreated(undefined)}>
              dismiss
            </Button>
          </div>
          {config === undefined ? null : (
            <CopyValue label="MCP URL" value={config.audience} testId="session-mcp-created-url" />
          )}
          <CopyValue label="Client ID" value={visibleCreated.clientId} testId="session-mcp-created-id" />
          <CopyValue
            label="one-time client secret"
            value={visibleCreated.clientSecret}
            testId="session-mcp-created-secret"
          />
          <p className="text-xs leading-relaxed text-doom-faint">
            Paste these values into ChatGPT. Select <code>client_secret_post</code> as the token endpoint auth method,
            not <code>none</code>. The secret is shown only once and disappears on dismissal, navigation, or session
            change.
          </p>
        </div>
      )}

      <div className="flex flex-col gap-2" data-testid="session-mcp-clients">
        <span className="text-sm font-bold text-doom-hi">registered clients</span>
        {clients.length === 0 && !loading ? (
          <span className="text-sm text-doom-faint">no clients registered for this session.</span>
        ) : null}
        {clients.map((client) => (
          <div
            key={client.clientId}
            className="flex flex-col gap-2 rounded-md border border-doom-border p-3 sm:flex-row sm:items-start"
          >
            <div className="min-w-0 flex-1 text-sm">
              <div className="flex flex-wrap items-center gap-2">
                <span className="font-bold text-doom-hi">{client.name}</span>
                <Badge tone="neutral">{client.scope === 'session' ? 'session scope' : 'restricted scope'}</Badge>
                <Badge tone="neutral">{client.tokenEndpointAuthMethod}</Badge>
              </div>
              <code className="block break-all text-xs text-doom-faint">{client.clientId}</code>
              <span className="block break-all text-xs text-doom-faint">{client.redirectUri}</span>
              {client.scope === 'session' ? (
                <span className="block text-xs text-doom-faint">access follows the live session surface</span>
              ) : (
                <span className="block text-xs text-doom-faint">
                  tools: {client.tools.join(', ') || 'none'} · skills: {client.skills.join(', ') || 'none'}
                </span>
              )}
            </div>
            <Button variant="outline" size="xs" disabled={busy} onClick={() => void revoke(client.clientId)}>
              revoke
            </Button>
          </div>
        ))}
      </div>

      <p className="text-xs leading-relaxed text-doom-faint">
        verified clients are saved for this session. after a restart, reconnect with the existing client and MCP URL.
        authorization tokens remain runtime-bound, so authorization may be required again.
      </p>
    </section>
  );
}
