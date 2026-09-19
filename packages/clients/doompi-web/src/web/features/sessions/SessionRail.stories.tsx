/*
 * Plain CSF objects; the style-system renderer resolves the default export by
 * looking for a bare `const meta`, so the export is not named at definition.
 */
import { Button, GearIcon, KebabIcon, PlusIcon } from '@agimon-ai/doompi-web-components';
import type { ReactNode } from 'react';

import type { SessionSummary } from '../../../types/hub';
import type { SessionMeta } from '../../stores/sessionsStore';
import { SessionCardView, SessionRailView, WorkspaceGroupView } from './SessionRailView';

const noop = (): void => undefined;

function session(id: string, name: string, workspaceId: string, active = false): SessionMeta {
  const summary: SessionSummary = {
    workspaceId,
    id,
    name,
    cwd: `/Users/dev/workspace/${workspaceId}`,
    createdAt: '2026-08-24T00:00:00.000Z',
    updatedAt: '2026-08-24T00:00:00.000Z',
    phase: active ? 'turn' : 'idle',
    phaseSince: '2026-08-24T00:00:00.000Z',
    attach: 'attached',
    pendingMessageCount: 0,
    everPrompted: true,
    awaitingInput: false,
  };
  return { summary, attach: 'attached', reason: '', replayed: 0, dropped: 0 };
}

function icon(label: string, kind: 'plus' | 'menu') {
  return (
    <Button variant="ghost" size="icon" aria-label={label} onClick={noop} className="text-doom-faint">
      {kind === 'plus' ? <PlusIcon className="h-3 w-3" /> : <KebabIcon className="h-3 w-3" />}
    </Button>
  );
}

function card(meta: SessionMeta, ordinal: number, active = false) {
  return (
    <SessionCardView
      key={meta.summary.id}
      meta={meta}
      ordinal={ordinal}
      active={active}
      status={active ? 'running · now' : 'idle · 12m'}
      onOpen={noop}
      menu={icon(`${meta.summary.name} actions`, 'menu')}
    />
  );
}

function rail(groups: ReactNode, hasWorkspaces = true) {
  return (
    <div className="h-screen w-80 bg-doom-rail">
      <SessionRailView
        hasWorkspaces={hasWorkspaces}
        workspaceGroups={groups}
        remoteAccessButton={
          <Button variant="outline" size="sm">
            remote access
          </Button>
        }
        settingsLink={
          <Button variant="ghost" size="icon" aria-label="settings">
            <GearIcon className="h-3 w-3" />
          </Button>
        }
        onOpenRemote={noop}
        onAddWorkspace={noop}
        onTurnRemoteOff={noop}
      />
    </div>
  );
}

const meta = {
  title: 'Web/Sessions/Workspace session rail',
  component: SessionRailView,
  tags: ['style-system'],
  parameters: { layout: 'fullscreen' },
};

export default meta;

export const MultipleWorkspaces = {
  render: () =>
    rail(
      <>
        <WorkspaceGroupView
          workspaceId="doompi"
          name="doompi"
          path="~/workspace/doompi"
          hasSessions
          cards={[
            card(session('rail', 'workspace session rail', 'doompi', true), 1, true),
            card(session('remote', 'fix remote access', 'doompi'), 2),
            card(session('release', 'release 0.8.0', 'doompi'), 3),
          ]}
          createAction={icon('new session in doompi', 'plus')}
          menuAction={icon('doompi actions', 'menu')}
        />
        <WorkspaceGroupView
          workspaceId="internal"
          name="doompi-internal"
          path="~/workspace/doompi-internal"
          hasSessions
          cards={card(session('metrics', 'provider metrics', 'internal'), 4)}
          createAction={icon('new session in doompi-internal', 'plus')}
          menuAction={icon('doompi-internal actions', 'menu')}
        />
      </>,
    ),
};

export const EmptyWorkspace = {
  render: () =>
    rail(
      <WorkspaceGroupView
        workspaceId="new-project"
        name="new-project"
        path="~/workspace/new-project"
        hasSessions={false}
        cards={null}
        createAction={icon('new session in new-project', 'plus')}
        menuAction={icon('new-project actions', 'menu')}
      />,
    ),
};

export const UnavailableWorkspace = {
  render: () =>
    rail(
      <WorkspaceGroupView
        workspaceId="missing"
        name="moved-project"
        path="~/workspace/moved-project"
        available={false}
        hasSessions={false}
        cards={null}
        createAction={icon('new session in moved-project', 'plus')}
        menuAction={icon('moved-project actions', 'menu')}
      />,
    ),
};

export const NoWorkspaces = {
  render: () => rail(null, false),
};
