import {
  type NativeTeamMemberSnapshot,
  type NativeTeamSnapshot,
  readActiveNativeTeamSnapshot,
} from '../intercom/nativeTeamChannel';

export type TeamMemberSnapshot = NativeTeamMemberSnapshot;
export type TeamSnapshot = NativeTeamSnapshot;

/** Read the active package-owned Team runtime without exposing its transport implementation. */
export function readActiveTeamSnapshot(now?: number): TeamSnapshot | undefined {
  return now === undefined ? readActiveNativeTeamSnapshot() : readActiveNativeTeamSnapshot(now);
}

/** Render only the bounded, resumable Team state safe to carry across compaction. */
export function formatTeamContextSnapshot(snapshot: TeamSnapshot | undefined): string | undefined {
  if (!snapshot) return undefined;
  if (snapshot.members.length === 0) return '(no active team members)';
  return snapshot.members
    .map((member) => {
      const details = [
        `role: ${member.role}`,
        member.agent ? `agent: ${member.agent}` : undefined,
        member.runId ? `run: ${member.runId}` : undefined,
        member.task ? `task ${member.task.id}: ${member.task.subject}` : undefined,
      ].filter((value): value is string => Boolean(value));
      return `- ${member.name} | ${details.join(' | ')}`;
    })
    .join('\n');
}
