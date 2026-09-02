import type { ContextItemDetail, ContextItemKind } from '@agimon-ai/doompi/contextApi';
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogHeader,
  DialogTitle,
  Panel,
  Spinner,
} from '@agimon-ai/doompi-web-components';
import { useEffect, useState } from 'react';
import { fetchContextItemDetail } from '../../lib/contextDetailApi.ts';

/**
 * What one row of the composition actually is.
 *
 * The panel answers "what does this cost"; a reader who clicks a row is asking
 * the follow-up, "and what am I paying for". That is the description the model
 * reads, the schema it is handed, and for a tool the split between the two,
 * because the two are cut differently: prose comes out with the package, a
 * schema only with the tool.
 *
 * Fetched on open rather than carried by the projection. The full text of every
 * tool in a composition is an order of magnitude larger than the figures, and
 * is wanted one row at a time.
 */

function tokens(value: number): string {
  return `~${value.toLocaleString()}`;
}

interface Target {
  itemKind: ContextItemKind;
  name: string;
  owner: string;
}

export interface ContextItemDialogProps {
  sessionId: string | null;
  target: Target | null;
  onClose: () => void;
}

export function ContextItemDialog({ sessionId, target, onClose }: ContextItemDialogProps) {
  const [detail, setDetail] = useState<ContextItemDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const itemKind = target?.itemKind ?? null;
  const name = target?.name ?? null;

  // A second click must not show the first row's answer for a frame, so the
  // reset happens during render rather than in the effect that refetches.
  const request =
    sessionId === null || itemKind === null || name === null ? null : `${sessionId}\u0000${itemKind}\u0000${name}`;
  const [shown, setShown] = useState<string | null>(null);
  if (shown !== request) {
    setShown(request);
    setDetail(null);
    setError(null);
  }

  useEffect(() => {
    if (sessionId === null || itemKind === null || name === null) return;
    // A reply that lands after the reader moved on belongs to a row that is no
    // longer open, so it is dropped rather than painted.
    let live = true;
    void fetchContextItemDetail(sessionId, itemKind, name).then((result) => {
      if (!live) return;
      if (result.ok) setDetail(result.detail);
      else setError(result.error);
    });
    return () => {
      live = false;
    };
  }, [sessionId, itemKind, name]);

  if (target === null) return null;

  return (
    <Dialog
      open
      onOpenChange={(next) => {
        if (!next) onClose();
      }}
    >
      <DialogContent width="lg" data-testid="context-item-dialog" aria-describedby={undefined}>
        <DialogHeader>
          <DialogTitle data-testid="context-item-title">{target.name}</DialogTitle>
          <span className="text-[9px] text-doom-faint">
            {target.itemKind} · {target.owner}
          </span>
        </DialogHeader>
        <DialogBody>
          {error !== null ? (
            <p data-testid="context-item-error" className="text-[11px] text-doom-dim">
              {error}
            </p>
          ) : detail === null ? (
            <p data-testid="context-item-loading" className="flex items-center gap-2 text-[11px] text-doom-dim">
              <Spinner />
              reading the session's inventory
            </p>
          ) : (
            <ContextItemBody detail={detail} />
          )}
        </DialogBody>
      </DialogContent>
    </Dialog>
  );
}

function ContextItemBody({ detail }: { detail: ContextItemDetail }) {
  return (
    <div className="flex flex-col gap-3">
      {detail.itemKind === 'tool' ? <ToolCost detail={detail} /> : <SkillFacts detail={detail} />}

      {detail.itemKind === 'skill' || detail.description !== undefined ? (
        <Section title="description">
          <p
            data-testid="context-item-description"
            className="text-[11px] leading-relaxed whitespace-pre-wrap text-doom-text"
          >
            {detail.description}
          </p>
        </Section>
      ) : null}

      {detail.itemKind === 'tool' && detail.promptSnippet !== undefined ? (
        <Section title="prompt snippet">
          <Pre testId="context-item-snippet">{detail.promptSnippet}</Pre>
        </Section>
      ) : null}

      {detail.itemKind === 'tool' && detail.promptGuidelines !== undefined ? (
        <Section title="prompt guidelines">
          <ul data-testid="context-item-guidelines" className="flex flex-col gap-1">
            {detail.promptGuidelines.map((line) => (
              <li key={line} className="text-[11px] leading-relaxed text-doom-dim">
                {line}
              </li>
            ))}
          </ul>
        </Section>
      ) : null}

      {detail.itemKind === 'tool' && detail.parameters !== undefined ? (
        <Section title="parameters">
          <Pre testId="context-item-schema">{JSON.stringify(detail.parameters, null, 2)}</Pre>
        </Section>
      ) : null}
    </div>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-1">
      <span className="text-[9px] font-bold tracking-widest text-doom-faint uppercase">{title}</span>
      {children}
    </div>
  );
}

function Pre({ testId, children }: { testId: string; children: string }) {
  return (
    <Panel className="max-h-64 overflow-auto bg-doom-deep px-3 py-2">
      <pre data-testid={testId} className="text-[11px] leading-relaxed whitespace-pre-wrap text-doom-dim">
        {children}
      </pre>
    </Panel>
  );
}

/** A tool is paid twice, so the split is the useful figure rather than the total. */
function ToolCost({ detail }: { detail: Extract<ContextItemDetail, { itemKind: 'tool' }> }) {
  return (
    <div data-testid="context-item-cost" className="flex flex-col gap-1">
      <Row label="schema" value={tokens(detail.tokens.schemaTokens)} />
      <Row label="system prompt" value={tokens(detail.tokens.promptTokens)} />
      <Row label="total" value={tokens(detail.tokens.totalTokens)} strong />
      {detail.active ? null : (
        <p className="text-[10px] text-doom-faint">not sent to the model; costs nothing until switched on</p>
      )}
    </div>
  );
}

function SkillFacts({ detail }: { detail: Extract<ContextItemDetail, { itemKind: 'skill' }> }) {
  return (
    <div data-testid="context-item-cost" className="flex flex-col gap-1">
      <Row label="listing" value={tokens(detail.tokens)} strong />
      <Row label="file" value={detail.filePath} />
      {detail.modelInvocable ? null : <p className="text-[10px] text-doom-faint">not offered to the model</p>}
    </div>
  );
}

function Row({ label, value, strong = false }: { label: string; value: string; strong?: boolean }) {
  return (
    <div className="flex items-baseline justify-between gap-3">
      <span className="text-[10px] text-doom-faint">{label}</span>
      <span className={`truncate text-[10px] ${strong ? 'font-bold text-doom-text' : 'text-doom-dim'}`}>{value}</span>
    </div>
  );
}
