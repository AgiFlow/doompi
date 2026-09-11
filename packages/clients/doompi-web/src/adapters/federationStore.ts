import { createPrivateKey, createPublicKey, generateKeyPairSync, randomUUID, sign as signBytes } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { FEDERATION_MAX_PEERS, federationIdentity, parseFederationPeer } from '../services/federationPolicy.ts';
import type { FederationIdentity, FederationPeer } from '../types/agentCatalog.ts';

const STORE_VERSION = 1;
const STORE_FILE = 'federation.json';
const PRIVATE_MODE = 0o600;
const DIRECTORY_MODE = 0o700;
const MAX_STORE_BYTES = 1024 * 1024;

interface FederationState {
  version: typeof STORE_VERSION;
  hubId: string;
  privateKey: string;
  peers: FederationPeer[];
}

export interface FederationStore {
  identity(): FederationIdentity;
  peers(): FederationPeer[];
  peer(hubId: string): FederationPeer | undefined;
  /** Signs a canonical handshake transcript without exposing the private key. */
  sign(payload: string): string;
  /** Existing keys/grants can change only with a matching prior fingerprint. */
  enroll(value: unknown, expectedFingerprint?: string): FederationPeer;
  revoke(hubId: string): boolean;
}

function privateKeyOf(encoded: string): ReturnType<typeof createPrivateKey> {
  if (encoded.length > 128 || !/^[A-Za-z0-9_-]+$/.test(encoded))
    throw new Error('Invalid stored federation signing key.');
  const bytes = Buffer.from(encoded, 'base64url');
  if (bytes.length > 96 || bytes.toString('base64url') !== encoded)
    throw new Error('Invalid stored federation signing key.');
  const privateKey = createPrivateKey({ key: bytes, format: 'der', type: 'pkcs8' });
  if (privateKey.asymmetricKeyType !== 'ed25519') throw new Error('Invalid stored federation signing key.');
  return privateKey;
}

function publicIdentity(state: FederationState): FederationIdentity {
  const privateKey = privateKeyOf(state.privateKey);
  return federationIdentity(
    state.hubId,
    createPublicKey(privateKey).export({ format: 'der', type: 'spki' }).toString('base64url'),
  );
}

function parseState(value: unknown): FederationState {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error('Invalid federation store.');
  const raw = value as Record<string, unknown>;
  if (
    raw.version !== STORE_VERSION ||
    typeof raw.hubId !== 'string' ||
    typeof raw.privateKey !== 'string' ||
    raw.privateKey.length > 256 ||
    !Array.isArray(raw.peers) ||
    raw.peers.length > FEDERATION_MAX_PEERS
  ) {
    throw new Error(
      'Unsupported or malformed federation store; restore it explicitly rather than replacing its identity.',
    );
  }
  const state: FederationState = {
    version: STORE_VERSION,
    hubId: raw.hubId,
    privateKey: raw.privateKey,
    peers: raw.peers.map(parseFederationPeer),
  };
  const identity = publicIdentity(state);
  if (
    new Set(state.peers.map((peer) => peer.hubId)).size !== state.peers.length ||
    new Set(state.peers.map((peer) => peer.fingerprint)).size !== state.peers.length ||
    state.peers.some((peer) => peer.hubId === state.hubId || peer.fingerprint === identity.fingerprint)
  ) {
    throw new Error('Duplicate or self-referential federation identity.');
  }
  return state;
}

/** Read through on every operation: another hub process cannot leave revoked grants cached here. */
export function createFederationStore(directory: string): FederationStore {
  const file = path.join(directory, STORE_FILE);
  const lock = `${file}.lock`;

  function read(): FederationState | undefined {
    let fd: number;
    try {
      fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
      throw error;
    }
    try {
      const stat = fs.fstatSync(fd);
      if (!stat.isFile() || stat.size > MAX_STORE_BYTES) throw new Error('Invalid federation store file.');
      fs.fchmodSync(fd, PRIVATE_MODE);
      return parseState(JSON.parse(fs.readFileSync(fd, 'utf8')));
    } finally {
      fs.closeSync(fd);
    }
  }

  function save(state: FederationState): void {
    const serialized = `${JSON.stringify(state)}\n`;
    if (Buffer.byteLength(serialized, 'utf8') > MAX_STORE_BYTES)
      throw new Error('Federation store exceeds its size limit.');
    const temporary = `${file}.${randomUUID()}.tmp`;
    const fd = fs.openSync(temporary, 'wx', PRIVATE_MODE);
    try {
      fs.writeFileSync(fd, serialized);
      fs.fsyncSync(fd);
    } catch (error) {
      fs.rmSync(temporary, { force: true });
      throw error;
    } finally {
      fs.closeSync(fd);
    }
    try {
      fs.renameSync(temporary, file);
      const parent = fs.openSync(directory, fs.constants.O_RDONLY);
      try {
        fs.fsyncSync(parent);
      } finally {
        fs.closeSync(parent);
      }
    } finally {
      fs.rmSync(temporary, { force: true });
    }
  }

  function update<T>(change: (state: FederationState) => T): T {
    fs.mkdirSync(directory, { recursive: true, mode: DIRECTORY_MODE });
    fs.chmodSync(directory, DIRECTORY_MODE);
    let fd: number;
    try {
      fd = fs.openSync(lock, 'wx', PRIVATE_MODE);
    } catch (error) {
      throw new Error(
        'Federation store is locked or unavailable. After a crash, confirm no writer is active before removing the lock.',
        { cause: error },
      );
    }
    try {
      let state = read();
      if (!state) {
        const keys = generateKeyPairSync('ed25519');
        state = {
          version: STORE_VERSION,
          hubId: randomUUID(),
          privateKey: keys.privateKey.export({ type: 'pkcs8', format: 'der' }).toString('base64url'),
          peers: [],
        };
      }
      const result = change(state);
      save(state);
      return result;
    } finally {
      fs.closeSync(fd);
      fs.unlinkSync(lock);
    }
  }

  const current = (): FederationState => read() ?? update((state) => state);
  return {
    identity: () => publicIdentity(current()),
    peers: () => current().peers.map((peer) => ({ ...peer, agentIds: [...peer.agentIds] })),
    peer: (hubId) => {
      const found = current().peers.find((candidate) => candidate.hubId === hubId);
      return found === undefined ? undefined : { ...found, agentIds: [...found.agentIds] };
    },
    sign(payload) {
      const state = current();
      return signBytes(null, Buffer.from(payload, 'utf8'), privateKeyOf(state.privateKey)).toString('base64url');
    },
    enroll(value, expectedFingerprint) {
      const peer = parseFederationPeer(value);
      return update((state) => {
        const own = publicIdentity(state);
        if (peer.hubId === own.hubId || peer.fingerprint === own.fingerprint)
          throw new Error('A hub cannot enroll itself.');
        const existing = state.peers.find((held) => held.hubId === peer.hubId);
        if (existing?.fingerprint !== expectedFingerprint)
          throw new Error('Peer changed; confirm its current fingerprint before replacing it.');
        if (state.peers.some((held) => held.hubId !== peer.hubId && held.fingerprint === peer.fingerprint))
          throw new Error('That key is already enrolled under another hub identity.');
        if (!existing && state.peers.length >= FEDERATION_MAX_PEERS) throw new Error('Federation peer limit reached.');
        state.peers = [...state.peers.filter((held) => held.hubId !== peer.hubId), peer];
        return peer;
      });
    },
    revoke(hubId) {
      return update((state) => {
        const previous = state.peers.length;
        state.peers = state.peers.filter((peer) => peer.hubId !== hubId);
        return state.peers.length !== previous;
      });
    },
  };
}
