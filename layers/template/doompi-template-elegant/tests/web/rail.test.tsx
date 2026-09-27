import type { WebTemplateProps } from '@agimon-ai/doompi-core/web';
import { templateRailStub } from '@agimon-ai/doompi-core/webTesting';
import { Children, isValidElement, type ReactElement, type ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import { ElegantAddWorkspaceDialog } from '../../src/extensions/(frontend)/template/_components/ElegantAddWorkspaceDialog';
import { ElegantLayout } from '../../src/extensions/(frontend)/template/_components/ElegantLayout';
import { ElegantRail } from '../../src/extensions/(frontend)/template/_components/ElegantRail';

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

/** The markup of one card, so an assertion cannot pass on a sibling's output. */
function card(markup: string, id: string): string {
  const start = markup.indexOf(`data-testid="session-card-${id}"`);
  expect(start).toBeGreaterThan(-1);
  const next = markup.indexOf('data-testid="session-card-', start + 1);
  return markup.slice(start, next === -1 ? undefined : next);
}

function rootChildren(rail: WebTemplateProps['rail']): ReactElement[] {
  const tree = ElegantLayout(props(rail)) as ReactElement<{ children: ReactNode }>;
  return Children.toArray(tree.props.children).filter(isValidElement);
}

describe('Elegant rail', () => {
  it('renders small-caps workspace labels and avatar-led tiles with the branch, never the cwd', () => {
    const markup = renderToStaticMarkup(<ElegantRail rail={templateRailStub().rail} />);

    expect(markup).toContain('data-testid="workspace-group-doompi"');
    expect(markup).toMatch(/tracking-widest[^"]*uppercase[^>]*>doompi</u);
    expect(markup).toContain('no sessions yet');

    const active = card(markup, 'rail');
    expect(active).toContain('data-testid="session-avatar"');
    expect(active).toContain('rounded-lg');
    expect(active).toContain('main*');
    expect(active).not.toContain('/Users/dev/workspace/doompi&lt;');

    const child = card(markup, 'rail-worktree');
    expect(child).toContain('data-nested="true"');
    expect(child).toContain('feature/rail');
    expect(child).toContain('RE');
    expect(markup).toContain('data-testid="pending-session-setup"');
    expect(markup).toContain('data-testid="settings-open"');
    expect(markup).toContain('data-testid="add-workspace-open"');
  });

  it('keeps the add-workspace dialog outside the drawer so it opens while the drawer is closed', () => {
    const open = rootChildren(templateRailStub({ addWorkspace: { suggestedPaths: [] } }).rail);
    expect(open.some((child) => child.type === ElegantAddWorkspaceDialog)).toBe(true);
    expect(rootChildren(templateRailStub().rail).some((child) => child.type === ElegantAddWorkspaceDialog)).toBe(false);
  });

  it('shows remote state and an empty-rail call to action', () => {
    const empty = renderToStaticMarkup(<ElegantRail rail={templateRailStub({ workspaces: [] }).rail} />);
    expect(empty).toContain('data-testid="add-workspace-empty"');
    expect(empty).not.toContain('data-testid="remote-banner"');

    const failed = renderToStaticMarkup(
      <ElegantRail
        rail={templateRailStub({ remote: { status: 'failed', deviceCount: 0, error: 'tunnel lost' } }).rail}
      />,
    );
    expect(failed).toContain('remote access failed: tunnel lost');
  });
});
