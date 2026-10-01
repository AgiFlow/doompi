import type {
  WebTemplateRailPendingSetup,
  WebTemplateRailSession,
  WebTemplateRailWorkspace,
} from '@agimon-ai/doompi-core/web';

import type { SessionSummary, WorkspaceSummary } from '../../types/hub';
import { personaInitials, sessionStatusLine, type AttachPhase } from './sessionSummary';

/** Sessions recorded without a workspace are grouped under this id. */
export const LEGACY_WORKSPACE_ID = 'legacy-workspace';

export interface RailSessionInput {
  summary: SessionSummary;
  attach: AttachPhase;
}

/** A restart the rail asked for: in flight, or failed with a reason. */
export interface RailRestartState {
  restarting: boolean;
  error?: string;
}

export interface SessionRailModelInput {
  /** Rail order across every workspace; positions become the 1-9 ordinals. */
  order: readonly string[];
  byId: Readonly<Record<string, RailSessionInput>>;
  activeId: string | null;
  workspaceOrder: readonly string[];
  workspacesById: Readonly<Record<string, WorkspaceSummary>>;
  /** Sessions rendered under their parent. */
  nested: ReadonlySet<string>;
  now: number;
  restarts: Readonly<Record<string, RailRestartState>>;
  /** Loaded profile avatars by session id. */
  avatarUrls: Readonly<Record<string, string>>;
}

export function workspaceName(workspace: Pick<WorkspaceSummary, 'root' | 'name'>): string {
  if (workspace.name) return workspace.name;
  const trimmed = workspace.root.replace(/\/+$/u, '');
  return trimmed.slice(trimmed.lastIndexOf('/') + 1) || workspace.root;
}

type PendingSetup = NonNullable<SessionSummary['pendingSetups']>[number];

/** The status and recovery copy for a setup-only child reservation. */
export function pendingSetupView(setup: PendingSetup): WebTemplateRailPendingSetup {
  const setupType =
    setup.setupKind === 'existing-directory'
      ? 'conversation directory'
      : setup.setupKind === 'managed-worktree'
        ? 'automatic worktree'
        : 'conversation';
  const status =
    setup.status === 'failed'
      ? `${setupType} setup failed`
      : setup.status === 'interrupted'
        ? `${setupType} setup interrupted`
        : `${setupType} provisioning`;
  const recovery =
    setup.setupKind === undefined && setup.cwd !== undefined
      ? 'This existing setup has no verified provider. Inspect its ownership in DoomPi before retrying.'
      : setup.errorCode === 'SESSION_UNAVAILABLE'
        ? 'The existing session is unavailable. Inspect or resume it in DoomPi before retrying the conversation.'
        : setup.status === 'interrupted'
          ? 'Retry the authenticated conversation to resume this setup. The same setup will be reused.'
          : setup.setupKind === 'existing-directory'
            ? 'Inspect the selected directory, then retry the authenticated conversation. The same setup will be reused.'
            : 'Resolve the Git setup, then retry the authenticated conversation. The same setup will be reused.';
  const needsRecovery = setup.status === 'failed' || setup.status === 'interrupted';
  return {
    id: setup.id,
    name: setup.name,
    status,
    failed: setup.status === 'failed',
    ...(needsRecovery ? { recovery } : {}),
  };
}

function sessionView(id: string, ordinal: number, input: SessionRailModelInput): WebTemplateRailSession {
  const { summary, attach } = input.byId[id]!;
  const restart = input.restarts[id];
  const restarting = restart?.restarting === true;
  const status = restarting
    ? 'restarting…'
    : sessionStatusLine(
        {
          attach,
          phase: summary.phase,
          phaseSince: summary.phaseSince,
          awaitingInput: summary.awaitingInput,
          everPrompted: summary.everPrompted,
          lastSettledAt: summary.lastSettledAt,
          dormant: summary.dormant,
          ...(summary.activity === undefined ? {} : { activity: summary.activity }),
        },
        input.now,
      );
  const nested = input.nested.has(id);
  const profile = summary.profile;
  const label = profile === undefined ? undefined : (profile.displayName ?? profile.name);
  const avatarUrl = input.avatarUrls[id];
  return {
    id,
    name: summary.name,
    ordinal,
    active: id === input.activeId,
    nested,
    ...(nested && summary.sessionProvenance !== undefined ? { provenance: summary.sessionProvenance } : {}),
    status,
    // The same priority the status copy uses: a refusal outranks the question,
    // and a restarting card is describing the restart, not the run it ended.
    // Background work that needs the reader, such as a failed workflow, is
    // marked the same way while the agent itself is idle.
    awaitingInput:
      (summary.awaitingInput ||
        (summary.activity?.attention === true && summary.phase === 'idle' && summary.dormant !== true)) &&
      attach !== 'refused' &&
      !restarting,
    restarting,
    ...(restart?.error === undefined ? {} : { error: restart.error }),
    ...(summary.git === undefined ? {} : { git: { branch: summary.git.branch, dirty: summary.git.dirty } }),
    ...(profile === undefined || label === undefined
      ? {}
      : {
          profile: {
            name: profile.name,
            label,
            initials: personaInitials(label),
            ...(avatarUrl === undefined ? {} : { avatarUrl }),
          },
        }),
    pendingSetups: (summary.pendingSetups ?? []).map(pendingSetupView),
  };
}

/** The rail's workspaces in host order, each with its sessions; ungrouped sessions last. */
export function buildRailWorkspaces(input: SessionRailModelInput): WebTemplateRailWorkspace[] {
  const ordinals = new Map(input.order.map((id, index) => [id, index + 1]));
  const grouped = new Set<string>();
  const workspaces: WebTemplateRailWorkspace[] = [];
  for (const workspaceId of input.workspaceOrder) {
    const workspace = input.workspacesById[workspaceId];
    if (workspace === undefined) continue;
    const ids = input.order.filter((id) => input.byId[id]?.summary.workspaceId === workspaceId);
    for (const id of ids) grouped.add(id);
    workspaces.push({
      id: workspaceId,
      name: workspaceName(workspace),
      root: workspace.root,
      available: workspace.available !== false,
      legacy: false,
      sessions: ids.map((id) => sessionView(id, ordinals.get(id) ?? 0, input)),
    });
  }
  const legacy = input.order.filter((id) => !grouped.has(id) && input.byId[id] !== undefined);
  if (legacy.length > 0) {
    const root = input.byId[legacy[0]!]!.summary.cwd;
    workspaces.push({
      id: LEGACY_WORKSPACE_ID,
      name: workspaceName({ root }),
      root,
      available: false,
      legacy: true,
      sessions: legacy.map((id) => sessionView(id, ordinals.get(id) ?? 0, input)),
    });
  }
  return workspaces;
}
