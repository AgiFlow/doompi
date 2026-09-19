import { DatabaseSync } from 'node:sqlite';

import {
  SessionGroupRevisionError,
  type SessionCommunicationGroup,
  type SessionGroupMutation,
  type SessionGroupStore,
  type SessionGroupStoreOptions,
} from './type';

interface GroupRow {
  group_id: string;
  owner_authority: string;
  revision: number;
}

const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;
const REFERENCE_PATTERN = /^peer\/[A-Za-z0-9][A-Za-z0-9._-]{0,127}\/[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;

function validateGroupId(value: string): void {
  if (!ID_PATTERN.test(value)) throw new TypeError('Session group IDs must be safe opaque IDs.');
}

function validateReference(value: string): void {
  if (!REFERENCE_PATTERN.test(value))
    throw new TypeError(`Session group member '${value}' is not a qualified reference.`);
}

/** Opens a revisioned SQLite registry for communication-only group membership. */
export function createSessionGroupStore(options: SessionGroupStoreOptions): SessionGroupStore {
  const database = new DatabaseSync(options.databasePath);
  database.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA foreign_keys = ON;
    CREATE TABLE IF NOT EXISTS session_groups (
      group_id TEXT PRIMARY KEY,
      owner_authority TEXT NOT NULL,
      revision INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS session_group_members (
      group_id TEXT NOT NULL REFERENCES session_groups(group_id) ON DELETE CASCADE,
      member_reference TEXT NOT NULL,
      PRIMARY KEY (group_id, member_reference)
    );
  `);

  const read = (groupId: string): SessionCommunicationGroup | undefined => {
    const row = database.prepare('SELECT * FROM session_groups WHERE group_id = ?').get(groupId) as
      | GroupRow
      | undefined;
    if (!row) return undefined;
    const members = database
      .prepare('SELECT member_reference FROM session_group_members WHERE group_id = ? ORDER BY member_reference')
      .all(groupId) as { member_reference: string }[];
    return Object.freeze({
      id: row.group_id,
      ownerAuthority: row.owner_authority,
      revision: row.revision,
      members: Object.freeze(members.map((member) => member.member_reference)),
    });
  };

  const enroll = (groupId: string, members: readonly string[]): void => {
    const insert = database.prepare(
      'INSERT OR IGNORE INTO session_group_members (group_id, member_reference) VALUES (?, ?)',
    );
    for (const member of new Set(members)) {
      validateReference(member);
      if (options.validateEnrollment?.(groupId, member) === false)
        throw new Error(`Session group enrollment policy rejected '${member}'.`);
      insert.run(groupId, member);
    }
  };

  return {
    create(groupId, ownerAuthority, members) {
      validateGroupId(groupId);
      if (!ownerAuthority.trim()) throw new TypeError('Session group owner authority is required.');
      database.exec('BEGIN IMMEDIATE');
      try {
        database
          .prepare('INSERT INTO session_groups (group_id, owner_authority, revision) VALUES (?, ?, 1)')
          .run(groupId, ownerAuthority);
        enroll(groupId, members);
        database.exec('COMMIT');
      } catch (cause) {
        database.exec('ROLLBACK');
        throw cause;
      }
      return read(groupId)!;
    },
    mutate(mutation: SessionGroupMutation) {
      database.exec('BEGIN IMMEDIATE');
      try {
        const current = read(mutation.groupId);
        if (!current) throw new Error(`Session group '${mutation.groupId}' does not exist.`);
        if (
          mutation.authority !== current.ownerAuthority &&
          options.authorizeManagement?.(mutation.authority, current) !== true
        ) {
          throw new Error(`Authority '${mutation.authority}' cannot manage Session group '${mutation.groupId}'.`);
        }
        if (mutation.expectedRevision !== current.revision)
          throw new SessionGroupRevisionError(mutation.groupId, mutation.expectedRevision, current.revision);
        enroll(mutation.groupId, mutation.add ?? []);
        const remove = database.prepare(
          'DELETE FROM session_group_members WHERE group_id = ? AND member_reference = ?',
        );
        for (const member of new Set(mutation.remove ?? [])) {
          validateReference(member);
          remove.run(mutation.groupId, member);
        }
        database
          .prepare('UPDATE session_groups SET revision = revision + 1 WHERE group_id = ? AND revision = ?')
          .run(mutation.groupId, current.revision);
        database.exec('COMMIT');
      } catch (cause) {
        database.exec('ROLLBACK');
        throw cause;
      }
      return read(mutation.groupId)!;
    },
    get: read,
    groupsFor(memberReference) {
      validateReference(memberReference);
      const rows = database
        .prepare(
          `SELECT g.group_id FROM session_groups g
           INNER JOIN session_group_members m ON m.group_id = g.group_id
           WHERE m.member_reference = ? ORDER BY g.group_id`,
        )
        .all(memberReference) as { group_id: string }[];
      return rows.map((row) => read(row.group_id)!);
    },
    canMessage(groupId, sourceReference, targetReference) {
      validateReference(sourceReference);
      validateReference(targetReference);
      const row = database
        .prepare(
          `SELECT COUNT(*) AS count FROM session_group_members
           WHERE group_id = ? AND member_reference IN (?, ?)`,
        )
        .get(groupId, sourceReference, targetReference) as { count: number | bigint };
      return Number(row.count) === (sourceReference === targetReference ? 1 : 2);
    },
    close: () => database.close(),
  };
}

export {
  SessionGroupRevisionError,
  type SessionCommunicationGroup,
  type SessionGroupMutation,
  type SessionGroupStore,
  type SessionGroupStoreOptions,
} from './type';
