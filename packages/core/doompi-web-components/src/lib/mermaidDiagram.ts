/**
 * Mermaid, loaded only for a message that actually draws one.
 *
 * Mermaid is the largest thing this library can pull in, so nothing imports it
 * at module scope: the dynamic import below is its own chunk, fetched the
 * first time a `mermaid` fence renders and reused after that. The renderer
 * needs a document to measure text, so this module is browser-only by nature
 * and every caller is inside an effect.
 */

let loading: Promise<typeof import('mermaid').default> | undefined;

/** Loads and configures mermaid once per page. */
async function mermaidApi(): Promise<typeof import('mermaid').default> {
  loading ??= import('mermaid').then(({ default: mermaid }) => {
    mermaid.initialize({
      startOnLoad: false,
      // Diagram text follows the surface it sits on rather than mermaid's own
      // font stack, and the dark base is the only preset close to the cockpit.
      fontFamily: 'inherit',
      theme: 'dark',
      // Strict is mermaid's default and its sanitiser: labels are escaped and
      // script-carrying markup is stripped before the SVG is handed back,
      // which is what makes rendering diagram text from a model safe.
      securityLevel: 'strict',
    });
    return mermaid;
  });
  return loading;
}

/**
 * The SVG for one diagram.
 *
 * Rejects on invalid syntax, which for a streaming message is the normal case
 * until the fence closes; the caller shows the source until it resolves.
 */
export async function renderMermaid(id: string, code: string): Promise<string> {
  const mermaid = await mermaidApi();
  const { svg } = await mermaid.render(id, code);
  return svg;
}
