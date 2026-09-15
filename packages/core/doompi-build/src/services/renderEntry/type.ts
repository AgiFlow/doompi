/** What the renderers need beyond the resolved contributions themselves. */
export interface RenderOptions {
  /** The package's npm name, used as the extension and facet name. */
  readonly packageName: string;
  /** The cockpit plugin id. */
  readonly pluginId: string;
  /** Routing root, package-relative, so import specifiers can be made relative to it. */
  readonly root: string;
}
