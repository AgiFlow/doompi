import type { ExtensionAPI, MessageRenderOptions, Theme } from '@earendil-works/pi-coding-agent';
import type { Component } from '@earendil-works/pi-tui';
import { Text } from '@earendil-works/pi-tui';

import { SLASH_RESULT_CUSTOM_TYPE, type SlashRunDetail } from '../../../../../models/slashResult';
import { renderSlashRunNotice } from './_lib/slashRunNotice';

function asDetails(value: unknown): SlashRunDetail[] | undefined {
  if (!Array.isArray(value) || value.length === 0) return undefined;
  const isDetail = (entry: unknown): entry is SlashRunDetail =>
    typeof entry === 'object' &&
    entry !== null &&
    typeof (entry as SlashRunDetail).agent === 'string' &&
    typeof (entry as SlashRunDetail).status === 'string';
  return value.every(isDetail) ? value : undefined;
}

export function createSlashRunRenderer(): readonly [string, Parameters<ExtensionAPI['registerMessageRenderer']>[1]] {
  return [
    SLASH_RESULT_CUSTOM_TYPE,
    (message, _options: MessageRenderOptions, theme: Theme): Component => {
      const content = typeof message.content === 'string' ? message.content : '';
      const details = asDetails(message.details);
      // See the module header: no details means a plain-text report or a
      // pre-field transcript entry, both correct to show verbatim.
      if (!details) return new Text(content, 0, 0);
      return new Text(renderSlashRunNotice(details, theme), 0, 0);
    },
  ];
}

export default createSlashRunRenderer();
