export interface PersonaIdentity {
  name?: string;
  icon?: string;
}

export interface PersonaVoiceOverride {
  /** Engine voice id, e.g. a macOS `say` voice name. */
  voice?: string;
  /** Words per minute. */
  rate?: number;
}

export interface PersonaFrontMatter {
  /** Display name shown instead of the profile's directory name. */
  name?: string;
  /** Icon path, relative to the persona directory. */
  icon?: string;
  /** Narrowly scoped TTS override; the engine itself stays global. */
  voice?: PersonaVoiceOverride;
}

export interface PersonaDocument {
  frontMatter?: PersonaFrontMatter;
  /** The persona text with a recognised block removed, otherwise the input unchanged. */
  body: string;
}
