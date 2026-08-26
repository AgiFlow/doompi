import { MessageItem, MessageItemHeader, toolTone } from '@agimon-ai/doompi-web-components';
import type { ToolMessageRenderProps } from '@agimon-ai/doompi-web-contracts';
import { findCallView } from './builtinToolView.ts';
import { ListingBody, listingExpandable } from './ListingBody.tsx';

const LIMIT_KEY = 'resultLimitReached';
const LIMIT_UNIT = 'results';

/** The find tool's timeline item: `pattern · path · N results` over Pi's listing lines. */
export function FindToolMessage(props: ToolMessageRenderProps) {
  const view = findCallView(props.args);
  return (
    <MessageItem
      tone={toolTone({ running: props.running, isError: props.isError })}
      expandable={listingExpandable(props, LIMIT_KEY, LIMIT_UNIT)}
    >
      {({ expanded }) => (
        <>
          <MessageItemHeader title="find">
            <span data-testid="tool-call-find" className="flex min-w-0 flex-1 items-center gap-2">
              <span className="truncate text-doom-text">{view.primary}</span>
              {view.details.length > 0 ? (
                <span className="shrink-0 text-doom-faint">· {view.details.join(' · ')}</span>
              ) : null}
            </span>
          </MessageItemHeader>
          <ListingBody tool="find" limitKey={LIMIT_KEY} limitUnit={LIMIT_UNIT} expanded={expanded} props={props} />
        </>
      )}
    </MessageItem>
  );
}
