import type { WebTemplateProps } from '@agimon-ai/doompi-core/web';
import { renderToStaticMarkup } from 'react-dom/server';
import { expect, it } from 'vitest';

import { ElegantLayout } from '../../src/extensions/(frontend)/template/_components/ElegantLayout';
import { elegantTemplate } from '../../src/extensions/(frontend)/template/_lib/definition';

const props: WebTemplateProps = {
  view: 'conversation',
  navigationOpen: false,
  desktopActivityOpen: true,
  mobileActivityOpen: false,
  onNavigationOpenChange: () => {},
  onDesktopActivityOpenChange: () => {},
  onMobileActivityOpenChange: () => {},
  slots: {
    navigation: <nav>Sessions</nav>,
    header: (options) => {
      expect(options).toEqual({ navigationToggle: 'always', activityToggle: 'always' });
      return <header>Header</header>;
    },
    notices: null,
    content: <article>Conversation</article>,
    composer: <textarea aria-label="message" defaultValue="Draft" />,
    controls: <footer>Controls</footer>,
    activity: <aside>Activity</aside>,
  },
};

it('centers the conversation without mounting closed drawer content', () => {
  const html = renderToStaticMarkup(<ElegantLayout {...props} />);
  expect(html).toContain('max-w-[960px]');
  expect(html.match(/<article>/g)).toHaveLength(1);
  expect(html.match(/<textarea/g)).toHaveLength(1);
  expect(html).toContain('template-controls-toggle');
  expect(html).not.toContain('<aside>Activity');
  expect(html).not.toContain('<nav>Sessions');
  expect(elegantTemplate.layout).toBe(ElegantLayout);
});

it('does not constrain plugin panels or settings to the conversation width', () => {
  for (const view of ['panel', 'settings'] as const) {
    const html = renderToStaticMarkup(<ElegantLayout {...props} view={view} />);
    expect(html).not.toContain('max-w-[960px]');
  }
});
