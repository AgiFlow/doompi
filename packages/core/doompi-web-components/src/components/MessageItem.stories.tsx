/*
 * Plain CSF objects; see Badge.stories.tsx for why Storybook's types are not
 * imported. Every card is rendered in the state it should be screenshotted in,
 * so nothing here waits on the expand toggle.
 */
import { STATUS_TONES } from '../types/tone';
import { MessageItem, MessageItemBody, MessageItemGroup, MessageItemHeader, MessageItemStatus } from './MessageItem';

const meta = {
  title: 'Components/MessageItem',
  component: MessageItem,
  tags: ['style-system'],
};

export default meta;

export const Playground = {
  render: () => (
    <div className="flex flex-col gap-6 bg-doom-bg p-6">
      <div className="flex flex-col gap-2">
        <span className="text-2xs text-doom-dim uppercase tracking-widest">card · one per tone</span>
        <div className="flex max-w-lg flex-col gap-2">
          {STATUS_TONES.map((tone) => (
            <MessageItem key={tone} tone={tone} expandable defaultExpanded>
              <MessageItemHeader title="bash">
                <span className="min-w-0 truncate text-doom-faint">pnpm test doompi-web-components</span>
              </MessageItemHeader>
              <MessageItemBody>
                <MessageItemStatus tone={tone}>{tone}</MessageItemStatus>
              </MessageItemBody>
            </MessageItem>
          ))}
        </div>
      </div>

      <div className="flex flex-col gap-2">
        <span className="text-2xs text-doom-dim uppercase tracking-widest">card · collapsed with more hint</span>
        <div className="max-w-lg">
          <MessageItem tone="ok" expandable>
            <MessageItemHeader title="read">
              <span className="min-w-0 truncate text-doom-faint">src/lib/cn.ts</span>
            </MessageItemHeader>
            <MessageItemStatus expands className="px-3 pb-2">
              12 more lines
            </MessageItemStatus>
          </MessageItem>
        </div>
      </div>

      <div className="flex flex-col gap-2">
        <span className="text-2xs text-doom-dim uppercase tracking-widest">group · items become rows</span>
        <div className="max-w-lg">
          <MessageItemGroup tone="error" title="bash" summary="3 calls">
            <MessageItem tone="ok">
              <MessageItemHeader title="bash">
                <span className="min-w-0 truncate text-doom-faint">pnpm install</span>
              </MessageItemHeader>
            </MessageItem>
            <MessageItem tone="running">
              <MessageItemHeader title="bash">
                <span className="min-w-0 truncate text-doom-faint">pnpm build</span>
              </MessageItemHeader>
            </MessageItem>
            <MessageItem tone="error" defaultExpanded>
              <MessageItemHeader title="bash">
                <span className="min-w-0 truncate text-doom-faint">pnpm test</span>
              </MessageItemHeader>
              <MessageItemBody>exit code 1</MessageItemBody>
            </MessageItem>
          </MessageItemGroup>
        </div>
      </div>

      <div className="flex flex-col gap-2">
        <span className="text-2xs text-doom-dim uppercase tracking-widest">status · one glyph per tone</span>
        <div className="flex flex-wrap items-center gap-4 text-sm">
          {STATUS_TONES.map((tone) => (
            <MessageItemStatus key={tone} tone={tone}>
              {tone}
            </MessageItemStatus>
          ))}
        </div>
      </div>
    </div>
  ),
};
