import { DoomToolCall, DoomToolResult, renderToolHeading } from '@agimon-ai/doompi-ui/toolChrome';
import type { ExtensionAPI, Theme } from '@earendil-works/pi-coding-agent';
import { Container, Text } from '@earendil-works/pi-tui';

import { TEAM_MESSAGE_CUSTOM_TYPE, type IntercomMessageDetails } from '../../../../../../services/nativeTeamChannel';

function asDetails(value: unknown): IntercomMessageDetails | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const details = value as Partial<IntercomMessageDetails>;
  if (details.kind !== 'send' && details.kind !== 'ask') return undefined;
  if (!details.from || typeof details.from.name !== 'string') return undefined;
  if (typeof details.message !== 'string' || typeof details.requestId !== 'string') return undefined;
  return details as IntercomMessageDetails;
}

export function renderIntercomMessage(details: IntercomMessageDetails, theme: Theme): Container {
  let heading = renderToolHeading('intercom', `from ${details.from.name}`, theme);
  const metadata = [details.kind === 'ask' ? 'question' : 'message'];
  if (details.from.inline) metadata.push('inline');
  if (details.from.agent) metadata.push(details.from.agent);
  heading += ` ${theme.fg('muted', `· ${metadata.join(' · ')}`)}`;

  const container = new Container();
  container.addChild(new DoomToolCall(heading));
  container.addChild(
    new DoomToolResult(
      details.message.split('\n').map((line) => theme.fg('toolOutput', line)),
      theme,
      { wrap: true },
    ),
  );
  return container;
}

export function createIntercomMessageRenderer(): readonly [
  string,
  Parameters<ExtensionAPI['registerMessageRenderer']>[1],
] {
  return [
    TEAM_MESSAGE_CUSTOM_TYPE,
    (message, _options, theme) => {
      const details = asDetails(message.details);
      if (details) return renderIntercomMessage(details, theme);
      return new Text(typeof message.content === 'string' ? message.content : '', 0, 0);
    },
  ];
}

export default createIntercomMessageRenderer();
