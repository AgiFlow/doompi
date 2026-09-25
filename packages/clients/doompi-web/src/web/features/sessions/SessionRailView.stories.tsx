import { Button } from '@agimon-ai/doompi-web-components';

import { StoryFrame, seedStorySession } from '../../components/Story.fixture.tsx';
import { sessionsStore } from '../../stores/sessionsStore.ts';
import { SessionRailView } from './SessionRailView.tsx';
import { SessionCardView, WorkspaceGroupView } from './SessionRailView.tsx';

const meta = { title: 'Web/SessionRailView', component: SessionRailView, tags: ['style-system'] };
export default meta;

export const Playground = {
  render: () => {
    seedStorySession();
    const meta = sessionsStore.state.byId['story-session']!;
    return (
      <StoryFrame className="min-h-screen max-w-sm bg-doom-rail">
        <SessionRailView
          hasWorkspaces
          onOpenRemote={() => undefined}
          onAddWorkspace={() => undefined}
          onTurnRemoteOff={() => undefined}
          remoteAccessButton={<Button size="xs">Remote</Button>}
          settingsLink={<Button variant="ghost">Settings</Button>}
          workspaceGroups={
            <WorkspaceGroupView
              workspaceId="story-workspace"
              name="doompi"
              path="/workspace/doompi"
              hasSessions
              createAction={
                <Button size="icon" aria-label="New session">
                  +
                </Button>
              }
              menuAction={null}
              cards={
                <>
                  <SessionCardView
                    meta={meta}
                    ordinal={1}
                    active
                    status="Review component stories"
                    onOpen={() => undefined}
                  />
                  <SessionCardView
                    meta={{ ...meta, summary: { ...meta.summary, id: 'waiting', name: 'Review waiting for input' } }}
                    ordinal={2}
                    active={false}
                    awaitingInput
                    status="Select the next step"
                    onOpen={() => undefined}
                  />
                </>
              }
            />
          }
        />
      </StoryFrame>
    );
  },
};

export const Empty = {
  render: () => {
    seedStorySession();
    return (
      <StoryFrame className="min-h-screen max-w-sm bg-doom-rail">
        <SessionRailView
          hasWorkspaces={false}
          workspaceGroups={null}
          remoteAccessButton={null}
          settingsLink={<Button variant="ghost">Settings</Button>}
          onOpenRemote={() => undefined}
          onAddWorkspace={() => undefined}
          onTurnRemoteOff={() => undefined}
        />
      </StoryFrame>
    );
  },
};
