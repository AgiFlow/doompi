import { Markdown } from '@agimon-ai/doompi-web-components';
import { memo, useCallback, type ComponentProps } from 'react';

import { loadSessionAsset } from '../../lib/sessionAsset';

/**
 * A message's markdown, with the files this session changed as links.
 *
 * The host renders the conversation but owns no file panel, so a path in a
 * message can only become a link where a plugin claims it. Clicking one lands
 * in the same transient tab the activity dock opens, rather than a second view
 * of the same file.
 */
export type MessageFileLinkHandler = NonNullable<ComponentProps<typeof Markdown>['onFileLink']>;

export const MessageMarkdown = memo(function MessageMarkdown({
  sessionId,
  onFileLink,
  text,
}: {
  sessionId: string | null;
  onFileLink: MessageFileLinkHandler;
  text: string;
}) {
  const loadImage = useCallback(
    (path: string) => {
      if (sessionId === null) return Promise.reject(new Error('The session is unavailable.'));
      return loadSessionAsset(sessionId, path);
    },
    [sessionId],
  );
  return <Markdown text={text} onFileLink={onFileLink} loadImage={loadImage} />;
});
