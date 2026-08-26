import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { ComponentType } from 'react';

/**
 * One plugin component, rendered.
 *
 * No plugin component in the repository is imported by any test: stores and
 * pure helpers are covered per package, and the components are exercised only
 * by the browser suite. So the ordinary failures go unseen until a page is
 * opened, and the most ordinary of all is a component that throws on a state
 * the plugin can reach, which the host then catches and replaces with a
 * fallback nobody notices.
 *
 * Static markup rather than a DOM, matching the shared components package. It
 * proves a component mounts, reads the props the host actually sends, and puts
 * the expected text on the page. Clicks, effects, and Radix portals need a real
 * browser and stay with the Playwright suite.
 *
 * Callers pass components as values, never as JSX, so a plugin package needs no
 * JSX configuration in the project that holds its tests.
 */

export interface RenderedPlugin {
  /** The markup, or an empty string when the component threw. */
  html: string;
  /** What the component threw, which the host would have swallowed. */
  error: Error | undefined;
  /** Whether the rendered markup contains this text, ignoring the tags around it. */
  includes(text: string): boolean;
}

/** Tag-stripped text, so an assertion reads the page rather than the markup. */
function textOf(html: string): string {
  return html
    .replaceAll(/<[^>]*>/gu, ' ')
    .replaceAll(/\s+/gu, ' ')
    .trim();
}

export function renderPlugin<Props extends object>(component: ComponentType<Props>, props: Props): RenderedPlugin {
  try {
    const html = renderToStaticMarkup(createElement(component, props));
    return { html, error: undefined, includes: (text) => textOf(html).includes(text) };
  } catch (error) {
    // Returned rather than rethrown: the host catches a throwing item and keeps
    // the page up, so a test wanting to prove that needs the error as a value.
    return {
      html: '',
      error: error instanceof Error ? error : new Error(String(error)),
      includes: () => false,
    };
  }
}
