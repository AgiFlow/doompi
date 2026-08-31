import { Markdown } from '@agimon-ai/doompi-web-components';
import { useCallback } from 'react';
import { useFileLinks } from '../../lib/composition.ts';
import { openTransientTab } from '../../stores/transientTabsStore.ts';
import { useOpenTab } from '../../stores/useOpenTab.ts';

/**
 * A message's markdown, with the files this session changed as links.
 *
 * The host renders the conversation but owns no file panel, so a path in a
 * message can only become a link where a plugin claims it. Clicking one lands
 * in the same transient tab the activity dock opens, rather than a second view
 * of the same file.
 */
export function MessageMarkdown({ sessionId, text }: { sessionId: string | null; text: string }) {
  const resolve = useFileLinks(sessionId);
  const openTab = useOpenTab();
  const onFileLink = useCallback(
    (label: string) => {
      if (sessionId === null) return undefined;
      const tab = resolve(label);
      if (tab === undefined) return undefined;
      return () => {
        openTransientTab(sessionId, tab);
        openTab(tab.id);
      };
    },
    [resolve, sessionId, openTab],
  );
  return <Markdown text={text} onFileLink={onFileLink} />;
}
