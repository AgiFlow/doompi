import type { ExtensionAPI, MessageRenderOptions, Theme } from '@earendil-works/pi-coding-agent';
import type { Component } from '@earendil-works/pi-tui';
import { Text } from '@earendil-works/pi-tui';

import { SUBAGENT_NOTIFY_MESSAGE_TYPE, type CompletionNotifyDetails } from '../../../../../services/notify';
import { renderCompletionNotice } from './_lib/completionNotice';

function asDetails(value: unknown): CompletionNotifyDetails[] | undefined {
  if (!Array.isArray(value) || value.length === 0) return undefined;
  const isDetail = (entry: unknown): entry is CompletionNotifyDetails =>
    typeof entry === 'object' && entry !== null && typeof (entry as CompletionNotifyDetails).agent === 'string';
  return value.every(isDetail) ? value : undefined;
}

export function createCompletionRenderer(): readonly [string, Parameters<ExtensionAPI['registerMessageRenderer']>[1]] {
  return [
    SUBAGENT_NOTIFY_MESSAGE_TYPE,
    (message, options: MessageRenderOptions, theme: Theme): Component => {
      const content = typeof message.content === 'string' ? message.content : '';
      const details = asDetails(message.details);
      // See the module header: no details means a pre-field transcript entry,
      // not a message to re-derive by parsing.
      if (!details) return new Text(content, 0, 0);
      return new Text(renderCompletionNotice(details, { expanded: options.expanded === true }, theme), 0, 0);
    },
  ];
}

export default createCompletionRenderer();
