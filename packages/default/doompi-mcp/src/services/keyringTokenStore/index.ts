import { type AuthEntry, FileTokenStore, type TokenStore } from '@agimon-ai/mcp-proxy';

/** Keyring service name. One credential per downstream MCP server. */
export const KEYRING_SERVICE = 'ai.agimon.doom-mcp.oauth';

/** The slice of `@napi-rs/keyring`'s `AsyncEntry` this store uses. */
export interface KeyringEntry {
  getPassword(): Promise<string | undefined>;
  setPassword(password: string): Promise<void>;
  deletePassword(): Promise<unknown>;
}

export type KeyringEntryFactory = (service: string, account: string) => KeyringEntry;

/**
 * OAuth credentials in the OS keyring, with an owner-only file store behind it.
 *
 * The keyring is a native module and the platform service it talks to may be absent
 * (a headless Linux box with no secret service, an unsupported architecture). A
 * missing credential is reported as `undefined` rather than raised, so a rejection
 * means the keyring itself is unusable and the store degrades to the file fallback
 * for the rest of the session instead of failing the run.
 */
export class KeyringTokenStore implements TokenStore {
  private degraded = false;

  constructor(
    private readonly createEntry: KeyringEntryFactory,
    private readonly fallback: TokenStore = new FileTokenStore(),
  ) {}

  /** True once the keyring has failed and the file store has taken over. */
  get isDegraded(): boolean {
    return this.degraded;
  }

  async read(serverName: string): Promise<AuthEntry | undefined> {
    if (this.degraded) return this.fallback.read(serverName);
    let raw: string | undefined;
    try {
      raw = await this.createEntry(KEYRING_SERVICE, serverName).getPassword();
    } catch {
      this.degraded = true;
      return this.fallback.read(serverName);
    }
    if (!raw) return undefined;
    try {
      return JSON.parse(raw) as AuthEntry;
    } catch {
      // A credential we cannot parse is treated as absent so the next authorization
      // overwrites it, rather than wedging the server on every start.
      return undefined;
    }
  }

  async write(serverName: string, entry: AuthEntry): Promise<void> {
    if (!this.degraded) {
      try {
        await this.createEntry(KEYRING_SERVICE, serverName).setPassword(JSON.stringify(entry));
        return;
      } catch {
        this.degraded = true;
      }
    }
    await this.fallback.write(serverName, entry);
  }

  /**
   * Removes the credential from both stores.
   *
   * A session that degraded part way through can have left a copy in either place,
   * and "signed out" has to mean no credential survives anywhere. A keyring that
   * refuses the delete is reported rather than absorbed: the caller was told the
   * credential is gone, and it is not. The fallback is still cleared first so the
   * failure leaves one surviving copy instead of two.
   */
  async clear(serverName: string): Promise<void> {
    let keyringFailure: unknown;
    if (!this.degraded) {
      try {
        await this.createEntry(KEYRING_SERVICE, serverName).deletePassword();
      } catch (error) {
        keyringFailure = error;
      }
    }
    await this.fallback.clear(serverName);
    if (keyringFailure !== undefined) {
      const detail = keyringFailure instanceof Error ? keyringFailure.message : JSON.stringify(keyringFailure);
      throw new Error(`Keyring credential for "${serverName}" could not be removed: ${detail}`, {
        cause: keyringFailure,
      });
    }
  }
}

/**
 * Builds the token store for this host, falling back when the native module is absent.
 *
 * doom-mcp loads inside Pi, so a platform without a prebuilt keyring binary must
 * still get a working session rather than a failed extension install.
 */
export async function createTokenStore(fallback: TokenStore = new FileTokenStore()): Promise<TokenStore> {
  try {
    const { AsyncEntry } = await import('@napi-rs/keyring');
    return new KeyringTokenStore((service, account) => new AsyncEntry(service, account), fallback);
  } catch {
    return fallback;
  }
}
