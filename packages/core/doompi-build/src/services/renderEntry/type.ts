/** What the renderers need beyond the resolved contributions themselves. */
export interface RenderOptions {
  /** The package's npm name, used as the extension and facet name. */
  readonly packageName: string;
  /** The cockpit plugin id. */
  readonly pluginId: string;
  /** Routing root, package-relative. */
  readonly root: string;
  /** Where the generated entry is written, package-relative, so its imports can be made relative to it. */
  readonly entryDir: string;
  /** Backend declaration path to its package-owned browser widget key. */
  readonly mcpWidgets?: Readonly<Record<string, string>>;
}
