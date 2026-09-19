export interface SessionCommunicationGroup {
  readonly id: string;
  readonly ownerAuthority: string;
  readonly revision: number;
  readonly members: readonly string[];
}

export interface SessionGroupMutation {
  readonly groupId: string;
  readonly authority: string;
  readonly expectedRevision: number;
  readonly add?: readonly string[];
  readonly remove?: readonly string[];
}

export interface SessionGroupStoreOptions {
  readonly databasePath: string;
  readonly authorizeManagement?: (authority: string, group: SessionCommunicationGroup) => boolean;
  readonly validateEnrollment?: (groupId: string, memberReference: string) => boolean;
}

export interface SessionGroupStore {
  create(groupId: string, ownerAuthority: string, members: readonly string[]): SessionCommunicationGroup;
  mutate(mutation: SessionGroupMutation): SessionCommunicationGroup;
  get(groupId: string): SessionCommunicationGroup | undefined;
  groupsFor(memberReference: string): readonly SessionCommunicationGroup[];
  canMessage(groupId: string, sourceReference: string, targetReference: string): boolean;
  close(): void;
}

export class SessionGroupRevisionError extends Error {
  constructor(groupId: string, expected: number, actual: number) {
    super(`Session group '${groupId}' revision conflict: expected ${expected}, current ${actual}.`);
    this.name = 'SessionGroupRevisionError';
  }
}
