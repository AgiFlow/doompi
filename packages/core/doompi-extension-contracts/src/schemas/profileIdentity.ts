import { type Static, Type } from 'typebox';

/**
 * The custom session entry the runtime journals when the active profile's
 * persona identity changes.
 *
 * A profile has always been prompt text only, so a cockpit had nothing to show
 * for it beyond the profile name already published as footer status. This entry
 * carries the persona's display name and avatar so the transcript can attribute
 * each assistant message to the persona that produced it.
 *
 * It rides Pi's `entry_appended` frames on the road the agent-model projection
 * already uses, so any RPC client sees the change live and on replay without a
 * new protocol.
 *
 * Unlike the minor-mode, context, and agent-model projections, this entry is
 * NOT a projection: it is transcript, positioned in journal order. A cockpit
 * folding it must keep every occurrence rather than collapsing to the latest
 * one, because a message written before a switch keeps the identity it was
 * written under. Collapsing would rewrite history.
 */
export const DOOM_PROFILE_IDENTITY_ENTRY_TYPE = 'doom-profile-identity';

/**
 * Ceiling on the encoded icon, counted on the finished `data:` URL rather than
 * the file, so one number bounds both the journal entry and the transport.
 *
 * An avatar renders at 32 CSS pixels. This much room is already generous, and
 * the cap exists because the entry is replayed with the transcript: an oversize
 * icon is dropped and the persona keeps its name, never failing a profile load.
 */
export const PROFILE_ICON_MAX_DATA_URL_LENGTH = 262_144;

const MAX_PROFILE_NAME_LENGTH = 128;

/**
 * Image types allowed for a persona icon.
 *
 * Deliberately narrower than the cockpit's general media catalog: `image/svg+xml`
 * is excluded because an SVG rendered same-origin executes script, and the icon
 * path comes from user-authored persona front-matter. Do not reconcile this list
 * with the broader media type map.
 */
export const PROFILE_ICON_MIME_TYPES = ['image/png', 'image/jpeg', 'image/gif', 'image/webp'] as const;
export type ProfileIconMimeType = (typeof PROFILE_ICON_MIME_TYPES)[number];

export const ProfileIdentityProjectionSchema = Type.Object(
  {
    profile: Type.String({ minLength: 1, maxLength: MAX_PROFILE_NAME_LENGTH }),
    name: Type.Optional(Type.String({ minLength: 1, maxLength: MAX_PROFILE_NAME_LENGTH })),
    icon: Type.Optional(Type.String({ minLength: 1, maxLength: PROFILE_ICON_MAX_DATA_URL_LENGTH })),
  },
  { additionalProperties: false },
);

/** The persona a message was produced under: the profile name, plus optional display name and icon. */
export type ProfileIdentityProjection = Static<typeof ProfileIdentityProjectionSchema>;
