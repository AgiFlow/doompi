import fs from 'node:fs';
import path from 'node:path';

import type { SessionMcpPersistentRegistration } from '../sessionMcpAuthorization';

const DIRECTORY_MODE = 0o700;
const FILE_MODE = 0o600;
const LOOSE_MODE_MASK = 0o077;
const STORE_VERSION = 1;
const STORE_FILE = 'session-mcp-registrations.json';

export interface SessionMcpRegistrationStoreOptions {
  readonly stateDir: string;
  readonly onNotice?: (message: string) => void;
}

export interface SessionMcpRegistrationStore {
  registrations(): readonly SessionMcpPersistentRegistration[];
  save(registration: SessionMcpPersistentRegistration): boolean;
  remove(clientId: string): boolean;
}

interface StoredRegistrations {
  readonly version: number;
  readonly registrations: readonly SessionMcpPersistentRegistration[];
}

function validRegistration(value: unknown): value is SessionMcpPersistentRegistration {
  if (typeof value !== 'object' || value === null) return false;
  const registration = value as Partial<SessionMcpPersistentRegistration>;
  const client = registration.client;
  const binding = registration.binding;
  return (
    typeof registration.verifiedAt === 'number' &&
    Number.isSafeInteger(registration.verifiedAt) &&
    typeof registration.workspaceId === 'string' &&
    registration.workspaceId.trim() !== '' &&
    typeof registration.secretHash === 'string' &&
    /^[a-f0-9]{64}$/u.test(registration.secretHash) &&
    typeof client === 'object' &&
    client !== null &&
    typeof client.clientId === 'string' &&
    typeof client.name === 'string' &&
    typeof client.redirectUri === 'string' &&
    client.tokenEndpointAuthMethod === 'client_secret_post' &&
    typeof client.createdAt === 'number' &&
    typeof binding === 'object' &&
    binding !== null &&
    typeof binding.clientId === 'string' &&
    typeof binding.sessionId === 'string' &&
    typeof binding.audience === 'string' &&
    (binding.scope === 'session' || binding.scope === 'restricted') &&
    (binding.routing === undefined || binding.routing === 'session' || binding.routing === 'conversation') &&
    Array.isArray(binding.tools) &&
    binding.tools.every((name) => typeof name === 'string') &&
    Array.isArray(binding.skills) &&
    binding.skills.every((name) => typeof name === 'string')
  );
}

/** Private, machine-local records for OAuth clients that proved they can use Session MCP. */
export function createSessionMcpRegistrationStore(
  options: SessionMcpRegistrationStoreOptions,
): SessionMcpRegistrationStore {
  const notice = options.onNotice ?? ((): void => {});
  const storePath = path.join(options.stateDir, STORE_FILE);
  let current = load();

  function load(): SessionMcpPersistentRegistration[] {
    let raw: string;
    try {
      raw = fs.readFileSync(storePath, 'utf8');
      if ((fs.statSync(storePath).mode & LOOSE_MODE_MASK) !== 0) fs.chmodSync(storePath, FILE_MODE);
    } catch {
      return [];
    }
    try {
      const parsed: unknown = JSON.parse(raw);
      if (
        typeof parsed !== 'object' ||
        parsed === null ||
        (parsed as Partial<StoredRegistrations>).version !== STORE_VERSION ||
        !Array.isArray((parsed as Partial<StoredRegistrations>).registrations) ||
        !(parsed as Partial<StoredRegistrations>).registrations!.every(validRegistration)
      ) {
        notice(`session MCP registrations at ${storePath} are invalid; none will load`);
        return [];
      }
      return [...(parsed as StoredRegistrations).registrations];
    } catch {
      notice(`session MCP registrations at ${storePath} are not valid JSON; none will load`);
      return [];
    }
  }

  function write(next: readonly SessionMcpPersistentRegistration[]): boolean {
    const temporary = `${storePath}.${String(process.pid)}.tmp`;
    try {
      fs.mkdirSync(options.stateDir, { recursive: true, mode: DIRECTORY_MODE });
      fs.writeFileSync(
        temporary,
        `${JSON.stringify({ version: STORE_VERSION, registrations: next }, undefined, 2)}\n`,
        {
          mode: FILE_MODE,
        },
      );
      fs.renameSync(temporary, storePath);
      return true;
    } catch (error) {
      notice(
        `session MCP registrations at ${storePath} could not be saved: ${error instanceof Error ? error.message : String(error)}`,
      );
      try {
        fs.rmSync(temporary, { force: true });
      } catch {
        // The temporary file is not loaded and cannot grant access.
      }
      return false;
    }
  }

  return {
    registrations: () => current,
    save(registration) {
      const next = [...current.filter((held) => held.client.clientId !== registration.client.clientId), registration];
      if (!write(next)) return false;
      current = next;
      return true;
    },
    remove(clientId) {
      const next = current.filter((held) => held.client.clientId !== clientId);
      if (next.length === current.length) return true;
      if (!write(next)) return false;
      current = next;
      return true;
    },
  };
}
