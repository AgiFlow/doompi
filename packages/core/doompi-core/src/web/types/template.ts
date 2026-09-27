import type { ComponentType, ReactNode } from 'react';

/** Host content is independent of the selected presentation package. */
export interface WebTemplateSlots {
  header: (options: WebTemplateHeaderOptions) => ReactNode;
  notices: ReactNode;
  content: ReactNode;
  composer: ReactNode;
  controls: ReactNode;
  activity: ReactNode;
}

/** A drawer-based template keeps the corresponding header controls visible on desktop too. */
export interface WebTemplateHeaderOptions {
  navigationToggle: 'mobile' | 'always';
  activityToggle: 'mobile' | 'always';
}

/** A setup-only child reservation shown under its parent; it has no runtime of its own. */
export interface WebTemplateRailPendingSetup {
  id: string;
  name: string;
  /** Display copy such as "automatic worktree provisioning". */
  status: string;
  failed: boolean;
  /** What to do next, present once a setup failed or was interrupted. */
  recovery?: string;
}

/** One session card, with every value the host derives already computed. */
export interface WebTemplateRailSession {
  id: string;
  name: string;
  /** 1-based position across the whole rail; digits 1-9 focus it. */
  ordinal: number;
  active: boolean;
  /** Rendered under its parent session: one fixed indent, never multiplied by depth. */
  nested: boolean;
  /** The spawning package's label for a nested session, such as "worktree". */
  provenance?: string;
  status: string;
  awaitingInput: boolean;
  restarting: boolean;
  /** A failed restart; the template shows its own errors for actions it awaits. */
  error?: string;
  git?: { branch: string; dirty: boolean };
  profile?: {
    name: string;
    /** Display name, falling back to the profile name. */
    label: string;
    initials: string;
    /** Ready-to-render image URL; absent while loading or when the profile has no icon. */
    avatarUrl?: string;
  };
  pendingSetups: readonly WebTemplateRailPendingSetup[];
}

export interface WebTemplateRailWorkspace {
  id: string;
  name: string;
  root: string;
  available: boolean;
  /** Sessions recorded without a workspace; offers no create or workspace menu. */
  legacy: boolean;
  sessions: readonly WebTemplateRailSession[];
}

/** Resolves undefined on success, or the reason the action failed. */
export type WebTemplateRailResult = Promise<{ error: string } | undefined>;

export interface WebTemplateRailDirectoryListing {
  path: string;
  parent?: string;
  directories: readonly string[];
}

/** Everything the rail can ask the host to do. Actions that navigate also close a drawer rail. */
export interface WebTemplateRailActions {
  openSession: (sessionId: string) => void;
  renameSession: (sessionId: string, name: string) => void;
  restartSession: (sessionId: string) => void;
  removeSession: (sessionId: string) => WebTemplateRailResult;
  /** Opens the host's history dialog for one session. */
  resumeSession: (sessionId: string) => void;
  /** Opens the host's new-session dialog for a workspace. */
  createSession: (workspaceId: string) => void;
  resumeInWorkspace: (workspaceId: string) => void;
  openWorkspaceSettings: (workspaceId: string) => void;
  deleteWorkspace: (workspaceId: string) => WebTemplateRailResult;
  openAddWorkspace: () => void;
  closeAddWorkspace: () => void;
  /** Admits a folder, or with no path creates `~/.pi/.doom/workspace/<name>`. The host closes the dialog on success. */
  addWorkspace: (input: { name: string; path?: string }) => WebTemplateRailResult;
  searchDirectories: (query: string) => Promise<readonly string[]>;
  /** Lists a folder's visible child directories; home when no path is given. */
  listDirectory: (path?: string) => Promise<WebTemplateRailDirectoryListing | { error: string }>;
  removePendingSetup: (sessionId: string, setupId: string) => WebTemplateRailResult;
  openSettings: () => void;
  openRemoteAccess: () => void;
  turnRemoteAccessOff: () => void;
  /** Plugin menu items for a session; render first inside the session menu's content. */
  renderSessionMenuItems: (sessionId: string) => ReactNode;
}

/**
 * Session navigation data and actions. The template owns every piece of rail
 * presentation; the host keeps state, shortcuts, and the dialogs that call their
 * own APIs (new session, resume, remote access).
 */
export interface WebTemplateRail {
  /** Host order; the legacy group, when present, is last. */
  workspaces: readonly WebTemplateRailWorkspace[];
  remote: { status: 'off' | 'starting' | 'on' | 'failed'; host?: string; deviceCount: number; error?: string };
  /** Plugin fills for the rail region. */
  pluginContent: ReactNode;
  /**
   * Present while the add-workspace dialog is open. Render it at the layout root,
   * never inside a drawer that can unmount while closed.
   */
  addWorkspace?: { suggestedPaths: readonly string[] };
  actions: WebTemplateRailActions;
}

export interface WebTemplateProps {
  view: 'conversation' | 'panel' | 'settings' | 'welcome';
  slots: WebTemplateSlots;
  /** Session navigation, rendered by the template. A template that ignores it simply shows no rail. */
  rail: WebTemplateRail;
  navigationOpen: boolean;
  desktopActivityOpen: boolean;
  mobileActivityOpen: boolean;
  onNavigationOpenChange: (open: boolean) => void;
  onDesktopActivityOpenChange: (open: boolean) => void;
  onMobileActivityOpenChange: (open: boolean) => void;
}

/** A template is a browser contribution, never an agent mode or a separate session runtime. */
export interface WebTemplateContribution {
  id: string;
  label: string;
  description: string;
  contractVersion: 1;
  layout: ComponentType<WebTemplateProps>;
}
