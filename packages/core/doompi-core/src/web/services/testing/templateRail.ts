import type {
  WebTemplateRail,
  WebTemplateRailActions,
  WebTemplateRailSession,
  WebTemplateRailWorkspace,
} from '../../types/template';

/**
 * The rail a template receives, built for a test or story.
 *
 * Two workspaces with sessions that exercise the card's branches (a branch
 * with a dirty star, a profile avatar, a nested child, workflow sessions in
 * each state, a pending setup), plus
 * actions that record what the template asked for. Override any part.
 */

export interface RecordedRailAction {
  action: keyof WebTemplateRailActions;
  args: readonly unknown[];
}

export interface TemplateRailFixture {
  rail: WebTemplateRail;
  /** Every action the template called, in order. */
  readonly actions: readonly RecordedRailAction[];
}

export interface TemplateRailOptions {
  workspaces?: readonly WebTemplateRailWorkspace[];
  addWorkspace?: WebTemplateRail['addWorkspace'];
  remote?: WebTemplateRail['remote'];
  actions?: Partial<WebTemplateRailActions>;
}

/** A tiny transparent PNG, so avatar markup renders an image without a network request. */
const AVATAR_URL =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=';

export function railSession(overrides: Partial<WebTemplateRailSession> & { id: string }): WebTemplateRailSession {
  return {
    name: overrides.id,
    ordinal: 1,
    active: false,
    nested: false,
    status: 'idle · done 2m ago',
    awaitingInput: false,
    restarting: false,
    pendingSetups: [],
    ...overrides,
  };
}

export function defaultRailWorkspaces(): WebTemplateRailWorkspace[] {
  return [
    {
      id: 'doompi',
      name: 'doompi',
      root: '/Users/dev/workspace/doompi',
      available: true,
      legacy: false,
      sessions: [
        railSession({
          id: 'rail',
          name: 'rail redesign',
          ordinal: 1,
          active: true,
          status: 'running · 3m',
          git: { branch: 'main', dirty: true },
          profile: { name: 'ponytail', label: 'Ponytail', initials: 'PO', avatarUrl: AVATAR_URL },
        }),
        railSession({
          id: 'rail-worktree',
          name: 'worktree child',
          ordinal: 2,
          nested: true,
          provenance: 'worktree',
          git: { branch: 'feature/rail', dirty: false },
          profile: { name: 'reviewer', label: 'Reviewer', initials: 'RE' },
          pendingSetups: [
            {
              id: 'setup',
              name: 'docs worktree',
              status: 'automatic worktree setup failed',
              failed: true,
              recovery: 'Resolve the Git setup, then retry the authenticated conversation.',
            },
          ],
        }),
        railSession({
          id: 'rail-workflow',
          name: 'release-hardening',
          ordinal: 3,
          nested: true,
          provenance: 'workflow-session',
          status: 'workflow · build › edit token.ts · 4m',
        }),
        railSession({
          id: 'rail-workflow-failed',
          name: 'nightly',
          ordinal: 4,
          nested: true,
          provenance: 'workflow-session',
          status: 'workflow failed · test',
          awaitingInput: true,
        }),
        railSession({
          id: 'rail-workflow-done',
          name: 'hotfix',
          ordinal: 5,
          nested: true,
          provenance: 'workflow-session',
          status: 'stopped · open to wake',
        }),
      ],
    },
    {
      id: 'notes',
      name: 'Notes',
      root: '/Users/dev/.pi/.doom/workspace/Notes',
      available: true,
      legacy: false,
      sessions: [],
    },
  ];
}

export function templateRailStub(options: TemplateRailOptions = {}): TemplateRailFixture {
  const actions: RecordedRailAction[] = [];
  const record =
    <Name extends keyof WebTemplateRailActions>(action: Name, result?: unknown) =>
    (...args: unknown[]) => {
      actions.push({ action, args });
      return result;
    };
  const recorded: WebTemplateRailActions = {
    openSession: record('openSession'),
    renameSession: record('renameSession'),
    restartSession: record('restartSession'),
    removeSession: record('removeSession', Promise.resolve(undefined)) as WebTemplateRailActions['removeSession'],
    resumeSession: record('resumeSession'),
    createSession: record('createSession'),
    resumeInWorkspace: record('resumeInWorkspace'),
    openWorkspaceSettings: record('openWorkspaceSettings'),
    deleteWorkspace: record('deleteWorkspace', Promise.resolve(undefined)) as WebTemplateRailActions['deleteWorkspace'],
    openAddWorkspace: record('openAddWorkspace'),
    closeAddWorkspace: record('closeAddWorkspace'),
    addWorkspace: record('addWorkspace', Promise.resolve(undefined)) as WebTemplateRailActions['addWorkspace'],
    searchDirectories: record(
      'searchDirectories',
      Promise.resolve(['/Users/dev/workspace/doompi', '/Users/dev/workspace/docs']),
    ) as WebTemplateRailActions['searchDirectories'],
    listDirectory: record(
      'listDirectory',
      Promise.resolve({
        path: '/Users/dev',
        parent: '/Users',
        directories: ['/Users/dev/workspace', '/Users/dev/notes'],
      }),
    ) as WebTemplateRailActions['listDirectory'],
    removePendingSetup: record(
      'removePendingSetup',
      Promise.resolve(undefined),
    ) as WebTemplateRailActions['removePendingSetup'],
    openSettings: record('openSettings'),
    openRemoteAccess: record('openRemoteAccess'),
    turnRemoteAccessOff: record('turnRemoteAccessOff'),
    renderSessionMenuItems: () => null,
  };
  return {
    rail: {
      workspaces: options.workspaces ?? defaultRailWorkspaces(),
      remote: options.remote ?? { status: 'off', deviceCount: 0 },
      pluginContent: null,
      ...(options.addWorkspace === undefined ? {} : { addWorkspace: options.addWorkspace }),
      actions: { ...recorded, ...options.actions },
    },
    actions,
  };
}
