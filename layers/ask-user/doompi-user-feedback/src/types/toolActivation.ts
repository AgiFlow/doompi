/**
 * The slice of Pi's runtime tool list the ask-user gate drives.
 *
 * Pi binds these accessors to a started session runtime and throws before that, so a
 * holder must not call them until the session is ready.
 */
export interface ActiveToolRegistry {
  getActiveTools(): string[];
  setActiveTools(toolNames: string[]): void;
}
