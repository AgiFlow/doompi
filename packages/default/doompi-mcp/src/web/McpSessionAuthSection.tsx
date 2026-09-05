import {
  Button,
  Dialog,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  Input,
} from '@agimon-ai/doompi-web-components';
import type { SessionFrameSender, WebPluginSlotProps } from '@agimon-ai/doompi-web-contracts';
import { useEffect, useRef, useState } from 'react';
import { MCP_SESSION_AUTH_STATUS_KEY, parseMcpSessionAuthStatus } from '../types/webMcp.ts';

/** Requests authorization through Pi's command frame, never through a shell. */
export function requestMcpSessionAuthorization(
  sendSessionFrame: SessionFrameSender,
  sessionId: string,
  serverName: string,
): void {
  sendSessionFrame(sessionId, { type: 'prompt', message: `/mcp auth ${serverName}` });
}

function tokenEstimate(value: number | null): string {
  return value === null ? '—' : `~${value.toLocaleString()}`;
}

/** Keep configured servers actionable even before they have discovered any tools. */
export function McpSessionAuthSection({
  sessionId,
  statuses,
  sendSessionFrame,
  contextInventory = [],
}: WebPluginSlotProps) {
  const servers = parseMcpSessionAuthStatus(statuses[MCP_SESSION_AUTH_STATUS_KEY]) ?? [];
  const [target, setTarget] = useState<{ sessionId: string; name: string } | null>(null);
  const [copyFeedback, setCopyFeedback] = useState('');
  const [popupBlocked, setPopupBlocked] = useState(false);
  // Only retain a tab while it is our blank placeholder. Never close the provider's page.
  const pendingTab = useRef<Window | null>(null);
  const selected = target?.sessionId === sessionId ? target : null;
  const server = servers.find((item) => item.name === selected?.name);
  const authorizationUrl = server?.authorizationUrl;

  const closePendingTab = () => {
    pendingTab.current?.close();
    pendingTab.current = null;
  };

  useEffect(() => {
    const tab = pendingTab.current;
    if (!selected || !authorizationUrl || !tab || tab.closed) return;
    tab.location.replace(authorizationUrl);
    pendingTab.current = null;
  }, [selected, authorizationUrl]);

  useEffect(
    () => () => {
      pendingTab.current?.close();
      pendingTab.current = null;
    },
    [sessionId],
  );

  const authorize = (name: string) => {
    if (sessionId === null) return;
    const current = servers.find((item) => item.name === name);
    closePendingTab();
    setTarget({ sessionId, name });
    setCopyFeedback('');
    // Reserve the tab during the click. Opening it after asynchronous discovery is blocked by browsers.
    const tab = window.open('about:blank', '_blank');
    setPopupBlocked(tab === null);
    if (tab) {
      tab.opener = null;
      if (current?.authorizationUrl) {
        tab.location.replace(current.authorizationUrl);
      } else {
        tab.document.title = 'MCP authorization';
        tab.document.body.textContent = 'Preparing authorization. Return to DoomPi for progress or manual sign-in.';
        pendingTab.current = tab;
      }
    }
    if (!current?.authorizationUrl && current?.state !== 'connecting') {
      requestMcpSessionAuthorization(sendSessionFrame, sessionId, name);
    }
  };

  const copyLink = async () => {
    if (!authorizationUrl) return;
    try {
      await navigator.clipboard.writeText(authorizationUrl);
      setCopyFeedback('Link copied.');
    } catch {
      setCopyFeedback('Clipboard unavailable. Select the link above and copy it manually.');
    }
  };

  return (
    <>
      {servers.length === 0 ? null : (
        <section data-testid="context-mcp-auth" className="flex flex-col gap-2 border-b border-doom-border px-3 py-3">
          <div className="flex flex-col gap-0.5">
            <p className="text-[9px] font-bold uppercase tracking-wide text-doom-faint">MCP servers</p>
            <p className="text-[9px] leading-relaxed text-doom-muted">
              Open sign-in in a new tab, or copy the link from the authorization dialog.
            </p>
          </div>
          <ul aria-label="MCP servers" className="flex flex-col gap-2">
            {servers.map((item) => {
              const tools = contextInventory.filter(
                (inventoryItem) => inventoryItem.source === 'mcp' && inventoryItem.owner === item.name,
              );
              return (
                <li key={item.name} className="flex min-w-0 flex-col gap-1 px-1 py-0.5">
                  <div className="flex min-w-0 items-center gap-2">
                    <span className="min-w-0 flex-1 truncate text-[10px] text-doom-hi">{item.name}</span>
                    <span className="text-[9px] text-doom-muted">{item.state.replace(/-/g, ' ')}</span>
                    <Button
                      variant="subtle"
                      size="xs"
                      data-testid={`context-mcp-auth-${item.name}`}
                      aria-label={`${item.state === 'connected' ? 'Manage' : 'Authorize'} ${item.name}`}
                      disabled={sessionId === null || item.state === 'disabled'}
                      onClick={() => {
                        if (item.state !== 'connected') {
                          authorize(item.name);
                        } else if (sessionId !== null) {
                          closePendingTab();
                          setCopyFeedback('');
                          setPopupBlocked(false);
                          setTarget({ sessionId, name: item.name });
                        }
                      }}
                      className="shrink-0 text-[8px] font-bold"
                    >
                      {item.state === 'connected' ? 'manage' : 'authorize'}
                    </Button>
                  </div>
                  {tools.length === 0 ? (
                    <p className="pl-3 text-[9px] text-doom-faint">no tools reported</p>
                  ) : (
                    <ul aria-label={`${item.name} tools`} className="flex flex-col">
                      {tools.map((tool) => (
                        <li key={tool.name} className="flex min-w-0 items-center gap-2 py-px pl-3">
                          <span
                            className={`min-w-0 flex-1 truncate text-[9px] ${tool.active ? 'text-doom-muted' : 'text-doom-faint'}`}
                          >
                            {tool.name}
                          </span>
                          <span className="w-14 shrink-0 text-right text-[9px] text-doom-faint">
                            {tool.active ? tokenEstimate(tool.tokens) : `(${tokenEstimate(tool.tokens)})`}
                          </span>
                        </li>
                      ))}
                    </ul>
                  )}
                </li>
              );
            })}
          </ul>
        </section>
      )}
      <Dialog
        open={selected !== null}
        onOpenChange={(open) => {
          if (!open) {
            closePendingTab();
            setTarget(null);
          }
        }}
      >
        <DialogContent data-testid="mcp-authorization-dialog">
          <DialogHeader className="items-start px-4 py-4 sm:px-5">
            <div className="flex min-w-0 flex-1 flex-col gap-1.5">
              <DialogTitle className="break-words text-[14px] leading-snug">
                {server?.state === 'connected' ? 'Manage' : 'Authorize'} {selected?.name}
              </DialogTitle>
              <DialogDescription className="max-w-2xl">
                {server?.state === 'connected'
                  ? 'Disconnect this session without deleting saved credentials, or reauthorize to sign in again.'
                  : "Complete sign-in in the provider's tab. You can also open or copy the link below."}
              </DialogDescription>
            </div>
          </DialogHeader>
          <DialogBody className="px-4 py-4 sm:px-5 sm:py-5">
            <p role="status" className="text-[11px] text-doom-muted">
              {server?.state === 'connected'
                ? 'Authorization complete. This server is connected.'
                : server?.state === 'closed'
                  ? 'Disconnected from this session. Saved credentials were kept.'
                  : authorizationUrl
                    ? 'Waiting for you to complete authorization.'
                    : server?.state === 'failed'
                      ? 'Connection failed. Retry authorization; details are in the session transcript.'
                      : server
                        ? 'Preparing the authorization link...'
                        : 'This server is no longer available in the session.'}
            </p>
            {popupBlocked ? (
              <p className="text-[10px] text-doom-muted">
                The browser blocked the new tab. Open the link below when it is ready.
              </p>
            ) : null}
            {authorizationUrl ? (
              <div className="flex flex-col gap-2">
                <Input
                  aria-label="OAuth authorization URL"
                  readOnly
                  value={authorizationUrl}
                  onFocus={(event) => event.currentTarget.select()}
                />
                <a
                  href={authorizationUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-[11px] text-doom-accent underline underline-offset-2"
                >
                  open authorization page
                </a>
                <Button variant="outline" size="xs" onClick={() => void copyLink()}>
                  copy link
                </Button>
              </div>
            ) : null}
            {copyFeedback ? (
              <p role="status" className="text-[10px] text-doom-muted">
                {copyFeedback}
              </p>
            ) : null}
          </DialogBody>
          <DialogFooter className="flex-wrap justify-end border-t border-doom-border-soft px-4 py-3 sm:px-5">
            {server?.state === 'connected' && selected ? (
              <Button
                variant="outline"
                size="md"
                onClick={() => {
                  closePendingTab();
                  setCopyFeedback('');
                  setPopupBlocked(false);
                  sendSessionFrame(selected.sessionId, { type: 'prompt', message: `/mcp disconnect ${selected.name}` });
                }}
              >
                disconnect
              </Button>
            ) : null}
            {(server?.state === 'failed' || server?.state === 'connected' || server?.state === 'closed') && selected ? (
              <Button size="md" onClick={() => authorize(selected.name)}>
                {server.state === 'failed' ? 'retry authorization' : 'reauthorize'}
              </Button>
            ) : null}
            <Button
              variant="ghost"
              size="md"
              onClick={() => {
                closePendingTab();
                setTarget(null);
              }}
            >
              close
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
