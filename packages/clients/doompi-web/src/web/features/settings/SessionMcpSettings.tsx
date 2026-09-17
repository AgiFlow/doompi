import {
  Badge,
  Button,
  Checkbox,
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

function toggleGrant(current: string[], name: string, checked: boolean): string[] {
  return checked ? [...current, name] : current.filter((candidate) => candidate !== name);
}

function withoutSecret(client: CreatedSessionMcpClient): SessionMcpClient {
  const { clientSecret: _clientSecret, ...metadata } = client;
  return metadata;
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
  const [name, setName] = useState('');
  const [redirectUri, setRedirectUri] = useState('');
  const [tools, setTools] = useState<string[]>([]);
  const [skills, setSkills] = useState<string[]>([]);
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
    setName('');
    setRedirectUri('');
    setTools([]);
    setSkills([]);
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
  const canCreate =
    available &&
    !remoteCaller &&
    config !== undefined &&
    name.trim() !== '' &&
    exactHttpsUrl(redirectUri) &&
    tools.length + skills.length > 0 &&
    !busy;

  async function createClient(): Promise<void> {
    if (!canCreate || workspaceId === undefined) return;
    const operationSelection = selectionKey;
    setBusy(true);
    setError(undefined);
    const result = await createSessionMcpClient(workspaceId, sessionId, {
      name: name.trim(),
      redirectUri: redirectUri.trim(),
      tools,
      skills,
    });
    if (selectionKeyRef.current !== operationSelection) return;
    setBusy(false);
    if ('error' in result) {
      setError(result.error);
      return;
    }
    setCreated({ sessionId, client: result.client });
    setClients((current) => [withoutSecret(result.client), ...current]);
    setName('');
    setRedirectUri('');
    setTools([]);
    setSkills([]);
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
        <h3 className="text-sm font-bold text-doom-hi">session MCP clients</h3>
        <p className="text-sm leading-relaxed text-doom-faint">
          expose only selected capabilities from one live session to ChatGPT or another inbound MCP client. this is
          separate from outbound MCP servers, remote pairing, and remote control.
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
          loading the final active tools, skills, and clients…
        </p>
      ) : null}

      {error ? (
        <p role="alert" className="text-sm text-doom-red">
          {error}
        </p>
      ) : null}

      {config === undefined ? null : (
        <div className="flex flex-col gap-1 rounded-md border border-doom-border bg-doom-deep p-3 text-sm">
          <span className="text-doom-faint">public / local MCP URL</span>
          <code className="break-all text-doom-text" data-testid="session-mcp-url">
            {config.audience}
          </code>
          <span className="mt-1 text-doom-faint">authorization endpoint</span>
          <code className="break-all text-doom-text">{config.authorizationEndpoint}</code>
          <span className="mt-1 text-doom-faint">token endpoint</span>
          <code className="break-all text-doom-text">{config.tokenEndpoint}</code>
        </div>
      )}

      {config === undefined || remoteCaller ? null : (
        <div className="flex flex-col gap-3 rounded-md border border-doom-border p-3" data-testid="session-mcp-create">
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <label htmlFor="session-mcp-name" className="flex flex-col gap-1 text-sm text-doom-faint">
              client name
              <Input
                id="session-mcp-name"
                data-testid="session-mcp-name"
                value={name}
                placeholder="ChatGPT"
                onChange={(event) => setName(event.target.value)}
              />
            </label>
            <label htmlFor="session-mcp-callback" className="flex flex-col gap-1 text-sm text-doom-faint">
              exact ChatGPT HTTPS callback
              <Input
                id="session-mcp-callback"
                data-testid="session-mcp-callback"
                type="url"
                value={redirectUri}
                placeholder="https://chatgpt.com/…"
                aria-invalid={invalidCallback}
                onChange={(event) => setRedirectUri(event.target.value)}
              />
            </label>
          </div>
          {invalidCallback ? (
            <p className="text-xs text-doom-red">
              paste the exact absolute HTTPS callback without credentials or a fragment.
            </p>
          ) : null}

          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <div className="flex flex-col gap-2" data-testid="session-mcp-tools">
              <span className="text-sm font-bold text-doom-hi">tool grants</span>
              {config.tools.length === 0 ? <span className="text-xs text-doom-faint">no active tools</span> : null}
              {config.tools.map((tool, index) => (
                <label
                  key={tool.name}
                  htmlFor={`session-mcp-tool-${String(index)}`}
                  className="flex items-start gap-2 text-sm text-doom-text"
                >
                  <Checkbox
                    id={`session-mcp-tool-${String(index)}`}
                    checked={tools.includes(tool.name)}
                    onCheckedChange={(checked) =>
                      setTools((current) => toggleGrant(current, tool.name, checked === true))
                    }
                    aria-label={`grant tool ${tool.label}`}
                  />
                  <span>
                    <span className="block">{tool.label}</span>
                    <span className="block text-xs text-doom-faint">{tool.description}</span>
                  </span>
                </label>
              ))}
            </div>
            <div className="flex flex-col gap-2" data-testid="session-mcp-skills">
              <span className="text-sm font-bold text-doom-hi">skill grants</span>
              {config.skills.length === 0 ? <span className="text-xs text-doom-faint">no active skills</span> : null}
              {config.skills.map((skill, index) => (
                <label
                  key={skill.name}
                  htmlFor={`session-mcp-skill-${String(index)}`}
                  className="flex items-start gap-2 text-sm text-doom-text"
                >
                  <Checkbox
                    id={`session-mcp-skill-${String(index)}`}
                    checked={skills.includes(skill.name)}
                    onCheckedChange={(checked) =>
                      setSkills((current) => toggleGrant(current, skill.name, checked === true))
                    }
                    aria-label={`grant skill ${skill.name}`}
                  />
                  <span>
                    <span className="block">{skill.name}</span>
                    <span className="block text-xs text-doom-faint">{skill.description}</span>
                  </span>
                </label>
              ))}
            </div>
          </div>
          <p className="text-xs leading-relaxed text-doom-faint">
            granting <code>bash</code> lets the client run shell commands with this session&apos;s permissions. it can
            read, change, or remove files, so grant it only to a client you trust.
          </p>
          <Button
            data-testid="session-mcp-create-button"
            loading={busy}
            disabled={!canCreate}
            onClick={() => void createClient()}
          >
            create client
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
          className="flex flex-col gap-2 rounded-md border border-doom-blue/50 bg-doom-deep p-3"
          data-testid="session-mcp-secret"
        >
          <div className="flex items-center justify-between gap-2">
            <span className="text-sm font-bold text-doom-hi">save this one-time secret now</span>
            <Button variant="ghost" size="xs" onClick={() => setCreated(undefined)}>
              dismiss
            </Button>
          </div>
          <span className="text-xs text-doom-faint">client ID</span>
          <code className="break-all text-sm text-doom-text" data-testid="session-mcp-created-id">
            {visibleCreated.clientId}
          </code>
          <span className="text-xs text-doom-faint">one-time client secret</span>
          <code className="break-all text-sm text-doom-text" data-testid="session-mcp-created-secret">
            {visibleCreated.clientSecret}
          </code>
          <p className="text-xs leading-relaxed text-doom-faint">
            ChatGPT must authenticate at the token endpoint with <code>client_secret_post</code>: send the client ID and
            secret as <code>client_id</code> and <code>client_secret</code> form fields. this secret is kept only in
            this panel and disappears on dismissal, navigation, or session change.
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
                <Badge tone="neutral">{client.tokenEndpointAuthMethod}</Badge>
              </div>
              <code className="block break-all text-xs text-doom-faint">{client.clientId}</code>
              <span className="block break-all text-xs text-doom-faint">{client.redirectUri}</span>
              <span className="block text-xs text-doom-faint">
                tools: {client.tools.join(', ') || 'none'} · skills: {client.skills.join(', ') || 'none'}
              </span>
            </div>
            <Button variant="outline" size="xs" disabled={busy} onClick={() => void revoke(client.clientId)}>
              revoke
            </Button>
          </div>
        ))}
      </div>

      <p className="text-xs leading-relaxed text-doom-faint">
        session MCP access is runtime-bound. restarting or ending this session invalidates its active authorization and
        tokens, so reconnect the client after the runtime changes.
      </p>
    </section>
  );
}
