import type { PersonaIdentity } from '@agimon-ai/doompi-config/profiles';
import {
  DOOM_PROFILE_IDENTITY_ENTRY_TYPE,
  type ProfileIdentityProjection,
} from '@agimon-ai/doompi-core/profile-identity';
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';

/**
 * Journals the persona the session is speaking as.
 *
 * A profile switch reloads the session, so each activation publishes once on
 * session start and the entries accumulate in journal order. That order is the
 * whole mechanism: a cockpit folding the journal forward attributes every
 * assistant message to the identity most recently published before it, which is
 * how a message keeps the persona it was written under after a switch.
 *
 * For that to hold, the entry must not be treated as a projection. A projection
 * keeps only the latest record and replays that one, which would repaint the
 * entire transcript as the current persona.
 */
export function publishProfileIdentity(
  pi: Pick<ExtensionAPI, 'appendEntry'>,
  profile: string | undefined,
  identity: PersonaIdentity | undefined,
  published: string | undefined,
): string | undefined {
  if (!profile) return published;

  const projection: ProfileIdentityProjection = {
    profile,
    ...(identity?.name === undefined ? {} : { name: identity.name }),
    ...(identity?.icon === undefined ? {} : { icon: identity.icon }),
  };
  const serialized = JSON.stringify(projection);
  // Reload republishes on every session start. Re-announcing an identity the
  // transcript already carries would add a seam where nothing changed.
  if (serialized === published) return published;
  pi.appendEntry(DOOM_PROFILE_IDENTITY_ENTRY_TYPE, projection);
  return serialized;
}
