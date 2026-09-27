import type { WebTemplateProps } from '@agimon-ai/doompi-core/web';
import { templateRailStub } from '@agimon-ai/doompi-core/webTesting';
import { TooltipProvider } from '@agimon-ai/doompi-web-components';
import { renderToStaticMarkup } from 'react-dom/server';
import { expect, it } from 'vitest';

import { AdvancedLayout } from '../../src/extensions/(frontend)/template/_components/AdvancedLayout';
import { advancedTemplate } from '../../src/extensions/(frontend)/template/_lib/definition';

it('renders host conversation slots once and requests the existing responsive header controls', () => {
  const props: WebTemplateProps = {
    view: 'conversation',
    navigationOpen: false,
    desktopActivityOpen: true,
    mobileActivityOpen: false,
    onNavigationOpenChange: () => {},
    onDesktopActivityOpenChange: () => {},
    onMobileActivityOpenChange: () => {},
    rail: templateRailStub().rail,
    slots: {
      header: (options) => {
        expect(options).toEqual({ navigationToggle: 'mobile', activityToggle: 'mobile' });
        return <header>Header</header>;
      },
      notices: <output>Notice</output>,
      content: <article>Conversation</article>,
      composer: <textarea aria-label="message" defaultValue="Draft" />,
      controls: <footer>Controls</footer>,
      activity: null,
    },
  };
  const html = renderToStaticMarkup(
    <TooltipProvider>
      <AdvancedLayout {...props} />
    </TooltipProvider>,
  );
  expect(html.match(/<article>/g)).toHaveLength(1);
  expect(html.match(/<textarea/g)).toHaveLength(1);
  expect(html).toContain('Notice');
  expect(html).toContain('Controls');
  expect(advancedTemplate.contractVersion).toBe(1);
  expect(advancedTemplate.layout).toBe(AdvancedLayout);
});
