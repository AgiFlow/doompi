import type { SessionMcpCallStatus } from '@agimon-ai/doompi-core/sessionMcp';
import {
  Accordion,
  AccordionContent,
  AccordionItem,
  AccordionTrigger,
  Button,
  CodeBlock,
  EmptyState,
  Input,
  SectionLabel,
  StatusBadge,
} from '@agimon-ai/doompi-web-components';
import { useState } from 'react';

import type { SessionMcpViewState } from './useSessionMcp';

const TONES = {
  running: 'running',
  succeeded: 'ok',
  failed: 'error',
  cancelled: 'neutral',
  interrupted: 'neutral',
} as const;

function CallStatus({ status }: { status: SessionMcpCallStatus }) {
  return (
    <StatusBadge tone={TONES[status]} size="xs">
      {status}
    </StatusBadge>
  );
}

function McpError({ state }: { state: SessionMcpViewState }) {
  return state.error === undefined ? null : (
    <div
      role="alert"
      className="flex items-center justify-between gap-3 border-b border-doom-border px-4 py-3 text-sm text-doom-red"
    >
      <span>{state.error} Displayed data may be out of date.</span>
      <Button variant="outline" size="xs" onClick={state.refresh}>
        retry
      </Button>
    </div>
  );
}

/** Remote calls are not chat messages and never enter the agent's transcript. */
export function SessionMcp({ state }: { state: SessionMcpViewState }) {
  const calls = state.snapshot?.calls ?? [];
  return (
    <section
      data-testid="session-mcp-history"
      aria-label="MCP call history"
      className="flex h-full min-h-0 flex-col bg-doom-bg text-doom-text"
    >
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-doom-border px-5 py-4">
        <div>
          <h2 className="text-lg font-bold text-doom-hi">Remote MCP activity</h2>
          <p className="mt-1 text-sm text-doom-dim">
            {state.snapshot?.total ?? 0} calls recorded · {state.before === undefined ? 'latest calls' : 'older calls'}
          </p>
        </div>
        {state.before === undefined ? (
          <StatusBadge tone={state.error ? 'error' : 'info'} size="sm">
            {state.error ? 'offline' : 'live'}
          </StatusBadge>
        ) : (
          <Button variant="outline" size="sm" onClick={state.showLatest}>
            latest calls
          </Button>
        )}
      </div>
      <McpError state={state} />
      <div className="min-h-0 flex-1 overflow-y-auto px-5" aria-busy={state.loading}>
        {state.loading ? (
          <EmptyState
            title="loading MCP calls"
            description="Reading this session's remote tool history."
            className="py-8"
          />
        ) : calls.length === 0 ? (
          <EmptyState
            title="no MCP calls recorded yet"
            description="Remote tool calls will appear here as they start. Calls made before history capture was added are not available."
            className="py-8"
          />
        ) : (
          <Accordion type="multiple">
            {calls.map((call) => (
              <AccordionItem key={call.id} value={call.id}>
                <AccordionTrigger className="py-3" data-testid={`mcp-call-${call.id}`}>
                  <span className="flex min-w-0 flex-1 flex-wrap items-center gap-x-3 gap-y-1">
                    <CallStatus status={call.status} />
                    <span className="min-w-0 break-all font-bold text-doom-hi">{call.toolName}</span>
                    <span className="ml-auto flex shrink-0 items-center gap-3 text-xs text-doom-dim">
                      <span>
                        {call.finishedAt === undefined
                          ? 'in progress'
                          : `${Math.max(0, call.finishedAt - call.startedAt).toLocaleString()} ms`}
                      </span>
                      <time
                        dateTime={new Date(call.startedAt).toISOString()}
                        title={new Date(call.startedAt).toLocaleString()}
                      >
                        {new Date(call.startedAt).toLocaleTimeString()}
                      </time>
                    </span>
                  </span>
                </AccordionTrigger>
                <AccordionContent className="space-y-3 pb-4">
                  <p className="text-xs text-doom-dim">
                    {call.clientName} · {new Date(call.startedAt).toLocaleString()}
                  </p>
                  <SectionLabel>arguments</SectionLabel>
                  <div className="max-h-64 overflow-auto">
                    <CodeBlock text={call.input} className="language-json" />
                  </div>
                  <SectionLabel>result</SectionLabel>
                  {call.output === undefined ? (
                    <p className="text-sm text-doom-dim">
                      {call.status === 'interrupted'
                        ? 'The host stopped before a result was recorded.'
                        : 'Waiting for the tool result.'}
                    </p>
                  ) : (
                    <div className="max-h-80 overflow-auto">
                      <CodeBlock text={call.output} className="language-json" />
                    </div>
                  )}
                </AccordionContent>
              </AccordionItem>
            ))}
          </Accordion>
        )}
      </div>
      <div className="flex flex-wrap items-center justify-between gap-3 border-t border-doom-border px-5 py-3">
        <p className="text-xs text-doom-dim">
          Text previews are limited to 16 KB. Common credential fields are redacted.
        </p>
        <Button
          variant="outline"
          size="sm"
          disabled={state.loading || state.snapshot?.nextBefore === undefined}
          onClick={state.loadOlder}
        >
          older calls
        </Button>
      </div>
    </section>
  );
}

/** Inventory comes from the same grant-filtered surface that the remote caller can use. */
export function SessionMcpTools({ state }: { state: SessionMcpViewState }) {
  const [query, setQuery] = useState('');
  const tools = state.snapshot?.tools ?? [];
  const filtered = tools.filter((tool) =>
    `${tool.name} ${tool.description}`.toLowerCase().includes(query.trim().toLowerCase()),
  );
  return (
    <section
      data-testid="session-mcp-tools"
      aria-label="Available MCP tools"
      className="flex min-h-0 flex-1 flex-col text-doom-text"
    >
      <div className="space-y-3 border-b border-doom-border-soft px-4 py-3">
        <div className="flex items-center justify-between gap-2">
          <SectionLabel>available tools</SectionLabel>
          <StatusBadge tone="info" size="xs">
            {tools.length}
          </StatusBadge>
        </div>
        <p className="text-xs text-doom-dim">Tools granted to this session's remote connections.</p>
        <Input
          aria-label="Search MCP tools"
          placeholder="search tools..."
          value={query}
          onChange={(event) => setQuery(event.target.value)}
        />
      </div>
      <McpError state={state} />
      <div className="min-h-0 flex-1 overflow-y-auto px-4" aria-busy={state.loading}>
        {state.snapshot === undefined && state.loading ? (
          <EmptyState title="loading tools" className="py-5" />
        ) : !state.snapshot?.available ? (
          <EmptyState
            title="no active MCP connection"
            description="History is retained. Available tools return when the session and its remote connection are active."
            className="py-5"
          />
        ) : filtered.length === 0 ? (
          <EmptyState
            title={query ? 'no matching tools' : 'no tools granted'}
            description={query ? 'Try a different tool name.' : 'This connection does not currently grant any tools.'}
            className="py-5"
          />
        ) : (
          <Accordion type="multiple">
            {filtered.map((tool) => (
              <AccordionItem key={tool.name} value={tool.name}>
                <AccordionTrigger className="py-3">
                  <span className="min-w-0 break-all font-bold">{tool.name}</span>
                </AccordionTrigger>
                <AccordionContent className="space-y-3 pb-3">
                  <p className="whitespace-pre-wrap break-words text-sm leading-relaxed">{tool.description}</p>
                  <p className="text-xs text-doom-dim">{tool.connections.join(', ')}</p>
                  <SectionLabel>input schema</SectionLabel>
                  <div className="max-h-64 overflow-auto">
                    <CodeBlock text={JSON.stringify(tool.inputSchema, null, 2)} className="language-json" />
                  </div>
                </AccordionContent>
              </AccordionItem>
            ))}
          </Accordion>
        )}
      </div>
    </section>
  );
}
