import { useEffect, useRef } from 'react';
import type { TimelineEntry } from '../../lib/sessionModel.ts';
import { submitMessage, useActiveSession } from '../../stores/sessionStore.ts';

const SUGGESTIONS = [
  'review the working tree and summarise the diff',
  'run the affected nx targets and report failures',
  'explain how the session socket handshake works',
];
import { ToolCard } from './ToolCard.tsx';

function Gutter({ label, tone }: { label: string; tone: string }) {
  return <span className={`w-11 shrink-0 pt-0.5 text-right text-[10px] font-bold ${tone}`}>{label}</span>;
}

function Entry({ entry }: { entry: TimelineEntry }) {
  if (entry.kind === 'user') {
    return (
      <div data-testid="entry-user" className="flex gap-3">
        <Gutter label="you" tone="text-doom-cyan" />
        <p className="min-w-0 flex-1 whitespace-pre-wrap break-words text-[13px] text-doom-hi">{entry.text}</p>
      </div>
    );
  }

  if (entry.kind === 'assistant') {
    return (
      <div data-testid="entry-assistant" data-streaming={entry.streaming} className="flex gap-3">
        <Gutter label="pi" tone="text-doom-magenta" />
        <div className="flex min-w-0 flex-1 flex-col gap-2">
          {entry.thinking ? (
            <p data-testid="entry-thinking" className="whitespace-pre-wrap break-words text-[11px] text-doom-violet/80">
              {entry.thinking}
            </p>
          ) : null}
          <p className="whitespace-pre-wrap break-words text-[13px] text-doom-text">
            {entry.text}
            {entry.streaming ? <span className="ml-0.5 inline-block h-3.5 w-2 translate-y-0.5 bg-doom-blue" /> : null}
          </p>
        </div>
      </div>
    );
  }

  if (entry.kind === 'tool') {
    return (
      <div className="flex gap-3">
        <Gutter label="tool" tone="text-doom-faint" />
        <div className="min-w-0 flex-1">
          <ToolCard entry={entry} />
        </div>
      </div>
    );
  }

  if (entry.kind === 'settled') {
    return (
      <div data-testid="entry-settled" className="flex items-center gap-3 pl-14">
        <span className="h-px flex-1 bg-doom-border-soft" />
        <span className="text-[10px] text-doom-faint">
          agent settled{entry.tools > 0 ? ` · ${entry.tools} tool${entry.tools === 1 ? '' : 's'}` : ''}
        </span>
        <span className="h-px flex-1 bg-doom-border-soft" />
      </div>
    );
  }

  if (entry.kind === 'queued') {
    return (
      <div data-testid="entry-queued" className="flex pl-[58px]">
        <span className="inline-flex items-center gap-2 self-start rounded border border-doom-border bg-doom-panel px-2.5 py-1.5 text-[10px] text-doom-dim">
          <span className="text-doom-cyan">&#8635;</span>
          queued follow-up: &quot;{entry.text}&quot;
        </span>
      </div>
    );
  }

  return (
    <div data-testid="entry-notice" className="flex gap-3">
      <Gutter label="!" tone="text-doom-red" />
      <p className="min-w-0 flex-1 break-words text-[12px] text-doom-red">{entry.text}</p>
    </div>
  );
}

export function Timeline() {
  const session = useActiveSession((state) => state);
  const bottom = useRef<HTMLDivElement>(null);

  useEffect(() => {
    bottom.current?.scrollIntoView({ block: 'end' });
  }, [session.entries]);

  if (session.entries.length === 0) {
    return (
      <div data-testid="timeline" className="flex flex-1 items-center justify-center">
        <div data-testid="timeline-empty" className="flex w-[520px] flex-col items-center gap-3 text-center">
          <span className="text-[14px] font-bold text-doom-hi">no messages yet</span>
          <span className="text-[11px] text-doom-dim">
            this session is attached and waiting. anything you send goes straight to the supervised agent.
          </span>
          <div className="mt-2 flex w-full flex-col gap-1.5">
            {SUGGESTIONS.map((suggestion, index) => (
              <button
                key={suggestion}
                type="button"
                data-testid={`suggestion-${index}`}
                onClick={() => submitMessage(suggestion)}
                className="flex items-center gap-2 rounded border border-doom-border bg-doom-panel px-3 py-2 text-left text-[11px] text-doom-text hover:border-doom-blue/50"
              >
                <span className="flex-1">{suggestion}</span>
                <span className="text-doom-faint">&#8599;</span>
              </button>
            ))}
          </div>
        </div>
      </div>
    );
  }

  return (
    <div data-testid="timeline" className="flex flex-1 flex-col gap-[18px] overflow-y-auto px-[26px] py-[22px]">
      {session.entries.map((entry) => (
        <Entry key={entry.id} entry={entry} />
      ))}
      <div ref={bottom} />
    </div>
  );
}
