import { Button, GearIcon, TooltipProvider } from '@agimon-ai/doompi-web-components';
import type { ReactNode } from 'react';

import type { SessionSummary } from '../../../types/hub';
import { RemoteAccessButton } from '../../components/RemoteAccessButton';
import type { SessionMeta } from '../../stores/sessionsStore';
import { SessionCardView, SessionRailView } from './SessionRailView';

const noop = (): void => undefined;

function makeMeta(summary: SessionSummary): SessionMeta {
  return { summary, attach: 'attached', reason: '', replayed: 0, dropped: 0 };
}

function StoryRail({ cards, hasSessions = true }: { cards: ReactNode; hasSessions?: boolean }) {
  return (
    <div className="h-[640px] w-[320px] overflow-hidden rounded-lg border border-doom-border bg-doom-rail">
      <SessionRailView
        hasSessions={hasSessions}
        cards={cards}
        remoteAccessButton={<RemoteAccessButton status="off" deviceCount={0} onOpen={noop} />}
        settingsLink={
          <Button variant="ghost" size="icon" aria-label="settings">
            <GearIcon className="h-3 w-3" />
          </Button>
        }
        onDismiss={noop}
        onOpenRemote={noop}
        onOpenNewSession={noop}
        onTurnRemoteOff={noop}
      />
    </div>
  );
}

const release = makeMeta({
  id: 'session-release',
  workspaceId: 'doompi',
  name: 'release',
  cwd: '/Users/vuongngo/workspace/doompi',
  createdAt: '2025-01-01T09:00:00.000Z',
  updatedAt: '2025-01-01T09:15:00.000Z',
  phase: 'idle',
  phaseSince: '2025-01-01T09:15:00.000Z',
  attach: 'attached',
  pendingMessageCount: 0,
  everPrompted: true,
  awaitingInput: false,
  dormant: true,
  git: { branch: 'main', dirty: false },
});

const workspace = makeMeta({
  id: 'session-workspace',
  workspaceId: 'doompi',
  name: 'doompi-web',
  cwd: '/Users/vuongngo/workspace/doompi/packages/clients/doompi-web',
  createdAt: '2025-01-01T09:02:00.000Z',
  updatedAt: '2025-01-01T09:18:00.000Z',
  phase: 'idle',
  phaseSince: '2025-01-01T09:18:00.000Z',
  attach: 'attached',
  pendingMessageCount: 0,
  everPrompted: false,
  awaitingInput: false,
  git: { branch: 'story/session-rail', dirty: true },
});

const waiting = makeMeta({
  id: 'session-review',
  workspaceId: 'doompi',
  name: 'review',
  cwd: '/Users/vuongngo/workspace/doompi',
  createdAt: '2025-01-01T09:04:00.000Z',
  updatedAt: '2025-01-01T09:20:00.000Z',
  phase: 'idle',
  phaseSince: '2025-01-01T09:20:00.000Z',
  attach: 'attached',
  pendingMessageCount: 0,
  everPrompted: true,
  awaitingInput: true,
  git: { branch: 'review', dirty: false },
});

const meta = {
  title: 'Features/Sessions/SessionRail',
  component: SessionRailView,
  tags: ['style-system'],
};

export default meta;

export const Playground = {
  render: () => (
    <TooltipProvider>
      <div className="flex min-h-screen flex-wrap items-start gap-6 bg-doom-bg p-6">
        <div className="flex flex-col gap-2">
          <span className="text-2xs text-doom-dim uppercase tracking-widest">active workspace</span>
          <StoryRail
            cards={
              <>
                <SessionCardView meta={release} ordinal={1} active={false} status="stopped · open to wake" />
                <SessionCardView meta={workspace} ordinal={2} active status="fresh session · nothing sent yet" />
              </>
            }
          />
        </div>
        <div className="flex flex-col gap-2">
          <span className="text-2xs text-doom-dim uppercase tracking-widest">waiting for input</span>
          <StoryRail
            cards={<SessionCardView meta={waiting} ordinal={1} active status="waiting for your input" awaitingInput />}
          />
        </div>
        <div className="flex flex-col gap-2">
          <span className="text-2xs text-doom-dim uppercase tracking-widest">empty</span>
          <StoryRail cards={null} hasSessions={false} />
        </div>
      </div>
    </TooltipProvider>
  ),
};
