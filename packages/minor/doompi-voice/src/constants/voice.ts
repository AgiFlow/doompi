export const COMMAND_NAME = 'voice';

/**
 * The mount both `voice` API trees register at.
 *
 * `(backend)/api/voice/` at global scope serves readiness and
 * `workspaces/sessions/(backend)/api/voice/` serves status and control, and the
 * folder name is what the build reads. This constant is the runtime half of
 * that same fact: two services used to spell it as a bare literal, one in
 * `voiceReadinessApi` and one in `voiceServer`, and nothing tied either to the
 * folder the mount is actually named by.
 */
export const VOICE_API_BASE_PATH = 'voice';
