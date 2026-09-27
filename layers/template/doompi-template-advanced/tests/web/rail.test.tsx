import type { WebTemplateProps } from '@agimon-ai/doompi-core/web';
import { railSession, templateRailStub } from '@agimon-ai/doompi-core/webTesting';
import { TooltipProvider } from '@agimon-ai/doompi-web-components';
import { Children, isValidElement, type ReactElement, type ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import { AdvancedAddWorkspaceDialog } from '../../src/extensions/(frontend)/template/_components/AdvancedAddWorkspaceDialog';
import { AdvancedLayout } from '../../src/extensions/(frontend)/template/_components/AdvancedLayout';

function props(rail: WebTemplateProps['rail']): WebTemplateProps {
  return {
    view: 'conversation',
    navigationOpen: false,
    desktopActivityOpen: false,
    mobileActivityOpen: false,
    onNavigationOpenChange: () => {},
    onDesktopActivityOpenChange: () => {},
    onMobileActivityOpenChange: () => {},
    rail,
    slots: {
      header: () => <header>Header</header>,
      notices: null,
      content: <article>Conversation</article>,
      composer: null,
      controls: null,
      activity: null,
    },
  };
}

function render(rail: WebTemplateProps['rail']): string {
  return renderToStaticMarkup(
    <TooltipProvider>
      <AdvancedLayout {...props(rail)} />
    </TooltipProvider>,
  );
}

/** The markup of one card, so an assertion cannot pass on a sibling's output. */
function card(markup: string, id: string): string {
  const start = markup.indexOf(`data-testid="session-card-${id}"`);
  expect(start).toBeGreaterThan(-1);
  const next = markup.indexOf('data-testid="session-card-', start + 1);
  return markup.slice(start, next === -1 ? undefined : next);
}

function rootChildren(rail: WebTemplateProps['rail']): ReactElement[] {
  const tree = AdvancedLayout(props(rail)) as ReactElement<{ children: ReactNode }>;
  return Children.toArray(tree.props.children).filter(isValidElement);
}

describe('Advanced rail', () => {
  it('renders workspaces with flat headings, avatars, and branches in place of the cwd', () => {
    const markup = render(templateRailStub().rail);

    expect(markup).toContain('data-testid="workspace-group-doompi"');
    expect(markup).toContain('data-testid="workspace-group-notes"');
    expect(markup).toContain('no sessions · create or resume one');
    expect(markup).toContain('data-testid="workspace-new-session-doompi"');
    expect(markup).not.toMatch(/workspace-group-doompi[^>]*>\s*<div class="[^"]*border border-doom-border/u);

    const active = card(markup, 'rail');
    expect(active).toContain('data-active="true"');
    expect(active).toContain('data-testid="session-open-rail"');
    expect(active).toContain('data-testid="session-avatar"');
    expect(active).toContain('main*');
    expect(active).toContain('press 1 to focus');
    expect(active).not.toContain('/Users/dev/workspace/doompi');

    const child = card(markup, 'rail-worktree');
    expect(child).toContain('data-nested="true"');
    expect(child).toContain('aria-label="automatic per-conversation worktree"');
    expect(child).toContain('feature/rail');
    expect(child).not.toContain('feature/rail*');
    expect(child).toContain('RE');
    expect(markup).toContain('data-testid="pending-session-setup"');
  });

  it('shows remote access state, the settings control, and an empty-rail add button', () => {
    const off = render(templateRailStub({ workspaces: [] }).rail);
    expect(off).toContain('data-testid="add-workspace-empty"');
    expect(off).toContain('data-testid="settings-open"');
    expect(off).not.toContain('data-testid="remote-banner"');

    const on = render(templateRailStub({ remote: { status: 'on', host: 'pi.example', deviceCount: 2 } }).rail);
    expect(on).toContain('data-testid="remote-access-live"');
    expect(on).toContain('remote access is on · pi.example · 2 devices paired');
  });

  it('shows awaiting input and a restart error on the card', () => {
    const markup = render(
      templateRailStub({
        workspaces: [
          {
            id: 'one',
            name: 'one',
            root: '/one',
            available: true,
            legacy: false,
            sessions: [
              railSession({ id: 'a', awaitingInput: true, status: 'waiting for your input', error: 'no hub' }),
            ],
          },
        ],
      }).rail,
    );
    expect(card(markup, 'a')).toContain('data-testid="session-awaiting-input"');
    expect(card(markup, 'a')).toContain('data-testid="session-error"');
  });

  it('opens the add-workspace dialog at the layout root, outside the rail', () => {
    const open = rootChildren(templateRailStub({ addWorkspace: { suggestedPaths: [] } }).rail);
    expect(open.some((child) => child.type === AdvancedAddWorkspaceDialog)).toBe(true);
    const closed = rootChildren(templateRailStub().rail);
    expect(closed.some((child) => child.type === AdvancedAddWorkspaceDialog)).toBe(false);
  });
});
