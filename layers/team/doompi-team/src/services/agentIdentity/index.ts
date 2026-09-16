/**
 * A readable, unique, addressable name for every spawned agent.
 *
 * An identity looks like `alan-reviewer-3`: a friendly name, the role it is
 * playing, and a session-wide sequence number. It replaces the previous
 * `<agent>-<runId prefix>` member id, which was unique but unreadable, and
 * which made a fan-out of four identical agents indistinguishable on screen.
 *
 * WHY A COUNTER RATHER THAN A HASH OF THE RUN ID:
 * Hashing a run id into a name list is cheap and needs no state, and the colour
 * picked by `agentIdentityColor` does exactly that. It is wrong here. A colour
 * that repeats is cosmetic; an address that repeats routes an intercom message
 * to the wrong agent. With 128 names, six concurrent runs collide about 11% of
 * the time. A counter collides never, and the number stays useful as a spawn
 * order marker.
 *
 * WHY A CLAIM FILE PER IDENTITY RATHER THAN ONE REGISTRY JSON:
 * `atomicJson` states plainly that an atomic write prevents torn reads but not
 * lost updates, and this package has no lease service. A single `names.json`
 * would be read-modify-write, which is precisely that hazard: two concurrent
 * spawns would both read counter N and both claim N. Creating a file with the
 * `wx` flag makes the filesystem itself the arbiter, so exactly one caller wins
 * and the loser simply tries the next number. `operationJournal` already uses
 * this primitive for the same reason.
 *
 * WHY THE SHAPE IS LOWERCASE AND HYPHENATED:
 * `normalizeTeamMemberName` lowercases, replaces anything outside
 * `[a-z0-9._-]`, and trims separators. An identity in this shape survives it
 * unchanged, so it can BE the intercom member id rather than an alias beside
 * one, and a model that copies it out of a members listing can address it
 * verbatim. It also can never equal the reserved `main`, because it always
 * carries a numeric suffix.
 *
 * AVOID:
 * - Failing a spawn because a claim could not be written; an unwritable scope
 *   directory degrades to the old run-id shape, it does not lose the run
 * - Releasing an identity when a run ends; a recycled name would label a live
 *   agent and a finished one in the same transcript
 * - Deriving the identity again downstream; it is minted once and carried
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

import { type SessionScope, sessionScopeDir } from '../sessionPaths';
import { parseVersioned } from '../versioned';

const IDENTITIES_DIR_NAME = 'agent-identities';
const IDENTITY_RECORD_VERSION = 1;
const MAX_ROLE_LENGTH = 24;
const FALLBACK_ROLE = 'agent';
const UNSAFE_IDENTITY_CHARS = /[^a-z0-9]+/g;
/** A spawn burst is small; this only bounds a pathological retry loop. */
const MAX_CLAIM_ATTEMPTS = 4096;

/**
 * Short, unambiguous first names. Deliberately ASCII and 3 to 6 characters, so
 * a narrow fleet roster row loses as little as possible to truncation.
 *
 * The list repeats once the counter passes its length, which is harmless: the
 * number keeps climbing, so `alan-reviewer-1` and `alan-tester-129` are still
 * distinct. There is therefore no exhaustion case to handle.
 */
export const AGENT_NAMES: readonly string[] = Object.freeze([
  'alan', 'bea', 'cyrus', 'dara', 'elin', 'faris', 'gita', 'hugo',
  'ines', 'jonas', 'kira', 'liam', 'mira', 'nadia', 'omar', 'petra',
  'quinn', 'rosa', 'said', 'tessa', 'uma', 'viktor', 'wren', 'xenia',
  'yusuf', 'zara', 'anika', 'bruno', 'clara', 'dmitri', 'esme', 'felix',
  'greta', 'hana', 'idris', 'juno', 'kasper', 'lena', 'mateo', 'nora',
  'oskar', 'pilar', 'rafiq', 'sonia', 'tomas', 'ulla', 'vera', 'wade',
  'yara', 'zane', 'amara', 'bodhi', 'celia', 'darian', 'edda', 'fiona',
  'gunnar', 'helia', 'ivan', 'jasmin', 'kaito', 'lucia', 'milan', 'nilsa',
  'otto', 'paloma', 'rhea', 'stellan', 'tariq', 'ursula', 'vidal', 'wilma',
  'yannis', 'zoya', 'adele', 'basim', 'cato', 'delia', 'emil', 'freya',
  'gabor', 'hilda', 'ismael', 'janna', 'kuno', 'leif', 'maren', 'niall',
  'odette', 'pavel', 'rania', 'sixten', 'thea', 'urban', 'vesna', 'wolf',
  'yestin', 'zelda', 'agnes', 'boris', 'cosima', 'dario', 'elias', 'fatima',
  'gilles', 'hedda', 'ilan', 'jorja', 'kemal', 'linnea', 'matias', 'noor',
  'olen', 'petros', 'rilla', 'soren', 'tova', 'ugo', 'valdis', 'wanda',
  'yosef', 'zinnia', 'arlo', 'birta', 'ciaran', 'dagny', 'eero', 'fabia',
]);

/** One claimed identity, written before the run it names is spawned. */
export interface AgentIdentityClaim {
  version: typeof IDENTITY_RECORD_VERSION;
  identity: string;
  name: string;
  role: string;
  number: number;
  agent: string;
  inline: boolean;
  runId: string;
  claimedAt: number;
}

export interface AgentIdentity {
  /** The addressable token, for example `alan-reviewer-3`. */
  identity: string;
  name: string;
  role: string;
  number: number;
  inline: boolean;
  /** False when the claim could not be written and the fallback shape was used. */
  persisted: boolean;
}

export interface AgentIdentityInput {
  agent: string;
  inline: boolean;
  runId: string;
}

export function agentIdentitiesDir(scope: SessionScope): string {
  return path.join(sessionScopeDir(scope), IDENTITIES_DIR_NAME);
}

/**
 * The role an identity advertises, taken from the last segment of the agent
 * name: `doompi-reviewer` reads as `reviewer`. The package prefix is shared by
 * every agent a package ships, so it is the part that carries no information.
 */
export function roleFromAgent(agent: string): string {
  const segments = agent.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
  const role = (segments.at(-1) ?? '').slice(0, MAX_ROLE_LENGTH);
  return role || FALLBACK_ROLE;
}

export function composeIdentity(role: string, sequence: number): string {
  const name = AGENT_NAMES[(sequence - 1) % AGENT_NAMES.length]!;
  return `${name}-${role}-${sequence}`;
}

/** The pre-identity member id, kept as the degraded shape when a claim cannot be written. */
function fallbackIdentity(input: AgentIdentityInput): string {
  const base = input.agent.toLowerCase().replace(UNSAFE_IDENTITY_CHARS, '-').replace(/^-+|-+$/g, '');
  return `${base || FALLBACK_ROLE}-${input.runId.slice(0, 8)}`;
}

function readClaim(file: string): AgentIdentityClaim | undefined {
  try {
    const parsed = parseVersioned<AgentIdentityClaim>(
      JSON.parse(fs.readFileSync(file, 'utf-8')),
      [IDENTITY_RECORD_VERSION],
    );
    return parsed.ok ? parsed.value : undefined;
  } catch {
    return undefined;
  }
}

function toIdentity(claim: AgentIdentityClaim, persisted: boolean): AgentIdentity {
  return {
    identity: claim.identity,
    name: claim.name,
    role: claim.role,
    number: claim.number,
    inline: claim.inline,
    persisted,
  };
}

/**
 * Claim the next free identity in this session.
 *
 * Re-claiming for the same run id returns the existing identity rather than
 * consuming another number, which keeps an operation-journal replay idempotent
 * without the journal needing to know identities exist.
 */
export function claimAgentIdentity(scope: SessionScope, input: AgentIdentityInput): AgentIdentity {
  const role = roleFromAgent(input.agent);
  const directory = agentIdentitiesDir(scope);
  let sequence = 1;
  try {
    fs.mkdirSync(directory, { recursive: true });
    sequence = fs.readdirSync(directory).length + 1;
  } catch {
    return { identity: fallbackIdentity(input), name: '', role, number: 0, inline: input.inline, persisted: false };
  }

  for (let attempt = 0; attempt < MAX_CLAIM_ATTEMPTS; attempt += 1, sequence += 1) {
    const identity = composeIdentity(role, sequence);
    const file = path.join(directory, `${identity}.json`);
    const claim: AgentIdentityClaim = {
      version: IDENTITY_RECORD_VERSION,
      identity,
      name: AGENT_NAMES[(sequence - 1) % AGENT_NAMES.length]!,
      role,
      number: sequence,
      agent: input.agent,
      inline: input.inline,
      runId: input.runId,
      claimedAt: Date.now(),
    };
    try {
      fs.writeFileSync(file, `${JSON.stringify(claim)}\n`, { flag: 'wx', mode: 0o600 });
      return toIdentity(claim, true);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') {
        return { identity: fallbackIdentity(input), name: '', role, number: 0, inline: input.inline, persisted: false };
      }
      const existing = readClaim(file);
      // Our own claim, seen again through a replayed operation.
      if (existing?.runId === input.runId) return toIdentity(existing, true);
    }
  }
  return { identity: fallbackIdentity(input), name: '', role, number: 0, inline: input.inline, persisted: false };
}

/**
 * Point an existing identity at a new run id.
 *
 * Restore mints a fresh run id for what is conceptually the same agent, so the
 * identity has to be carried across rather than derived again. This is a
 * single-writer rewrite of one claim, so the lost-update hazard that rules out
 * a shared registry file does not apply.
 */
export function adoptAgentIdentity(scope: SessionScope, identity: string, runId: string): void {
  const file = path.join(agentIdentitiesDir(scope), `${identity}.json`);
  const existing = readClaim(file);
  if (!existing) return;
  try {
    fs.writeFileSync(file, `${JSON.stringify({ ...existing, runId, claimedAt: Date.now() })}\n`, { mode: 0o600 });
  } catch {
    // A stale owner in the claim is cosmetic; the identity itself still holds.
  }
}

/** Render an identity for display, marking the inline case that has no agent file on disk. */
export function formatAgentIdentity(identity: string | undefined, inline?: boolean): string | undefined {
  if (!identity) return undefined;
  return inline ? `${identity} (inline)` : identity;
}
