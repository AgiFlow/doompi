import { expect, test } from '../support/cockpit.ts';

// Exactly what a live `doompi --mode rpc` session emitted, escapes and all.
const LIVE =
  '\u001b[38;2;81;175;239m[copilot]\u001b[39m\u001b[38;2;91;98;104m:\u001b[39m\u001b[38;2;156;160;164mdevelopment,testing\u001b[39m';
const PENDING = '\u001b[38;2;236;190;123m[minimal]\u001b[39m\u001b[38;2;156;160;164mdevelopment\u001b[39m';
const WITH_PROFILE =
  '\u001b[38;2;152;190;101m*reviewer*\u001b[39m:\u001b[38;2;81;175;239m[copilot]\u001b[39m:\u001b[38;2;156;160;164mplatform\u001b[39m';

const status = (statusKey: string, statusText?: string) => ({
  type: 'extension_ui_request',
  id: `st-${statusKey}-${Math.random()}`,
  method: 'setStatus',
  statusKey,
  ...(statusText === undefined ? {} : { statusText }),
});

test('renders the selection the session publishes on the bar', async ({ page, cockpit }) => {
  await page.goto(cockpit.url);
  await cockpit.session.waitForAttach();

  cockpit.session.emit(status('doom-major-mode', LIVE));
  cockpit.session.emit(status('doom-domain', 'development,testing'));

  await expect(page.getByTestId('selection-mode')).toHaveText('COPILOT');
  await expect(page.getByTestId('selection-domains')).toHaveText('development, testing');
  await expect(page.getByTestId('selection-bar')).toHaveAttribute('data-pending', 'false');
});

test('shows the profile the session publishes on its own axis', async ({ page, cockpit }) => {
  await page.goto(cockpit.url);
  await cockpit.session.waitForAttach();

  cockpit.session.emit(status('doom-major-mode', WITH_PROFILE));
  cockpit.session.emit(status('doom-profile', 'reviewer'));

  await expect(page.getByTestId('selection-profile')).toHaveText('*reviewer*');
  await expect(page.getByTestId('selection-mode')).toHaveText('COPILOT');
});

test('offers the empty profile axis once the session reports profiles exist', async ({ page, cockpit }) => {
  await page.goto(cockpit.url);
  await cockpit.session.waitForAttach();

  cockpit.session.emit(status('doom-profile', ''));

  await expect(page.getByTestId('selection-profile')).toHaveText('no profile');

  await page.getByTestId('axis-profile').click();
  const sent = await cockpit.session.waitForCommand('prompt');
  expect(sent.message).toBe('/profile');
});

test('turns the mode button amber while a switch is pending', async ({ page, cockpit }) => {
  await page.goto(cockpit.url);
  await cockpit.session.waitForAttach();

  cockpit.session.emit(status('doom-major-mode', LIVE));
  await expect(page.getByTestId('selection-bar')).toHaveAttribute('data-pending', 'false');

  cockpit.session.emit(status('doom-major-mode', PENDING));
  await expect(page.getByTestId('selection-bar')).toHaveAttribute('data-pending', 'true');
  await expect(page.getByTestId('selection-mode')).toHaveText('MINIMAL');
});

test('falls back to placeholders when the session publishes no selection', async ({ page, cockpit }) => {
  await page.goto(cockpit.url);
  await cockpit.session.waitForAttach();

  await expect(page.getByTestId('selection-mode')).toHaveText('MODE');
  // An axis the session has not published stays off the bar instead of
  // dangling an empty menu; an empty publish is what shows the placeholder.
  await expect(page.getByTestId('axis-profile')).toHaveCount(0);
  await expect(page.getByTestId('axis-domains')).toHaveCount(0);

  cockpit.session.emit(status('doom-domain', ''));
  await expect(page.getByTestId('selection-domains')).toHaveText('no domains');
});

test('invokes the command that changes the domains', async ({ page, cockpit }) => {
  await page.goto(cockpit.url);
  await cockpit.session.waitForAttach();

  cockpit.session.emit(status('doom-domain', 'development,testing'));
  await page.getByTestId('axis-domains').click();

  const sent = await cockpit.session.waitForCommand('prompt');
  expect(sent.message).toBe('/domains');
});

test('says the axis is asking until the agent answers', async ({ page, cockpit }) => {
  await page.goto(cockpit.url);
  await cockpit.session.waitForAttach();

  cockpit.session.emit(status('doom-major-mode', LIVE));
  // The chip reading the published mode is what proves the route has focused
  // the session; a click before that would go to no session at all.
  await expect(page.getByTestId('selection-mode')).toHaveText('COPILOT');
  const button = page.getByTestId('axis-mode');
  await expect(button).toHaveAttribute('data-pending', 'false');

  await button.click();
  await cockpit.session.waitForCommand('prompt');

  // The question is with the session; the button says so rather than looking
  // like a click that did nothing.
  await expect(button).toHaveAttribute('data-pending', 'true');

  cockpit.session.emit({
    type: 'extension_ui_request',
    id: 'mode-menu-pending',
    method: 'select',
    title: 'pick a major mode',
    options: ['minimal', 'copilot'],
  });

  await expect(page.getByTestId('dialog')).toBeVisible();
  await expect(button).toHaveAttribute('data-pending', 'false');
});

test('stops asking when the run settles without a menu', async ({ page, cockpit }) => {
  await page.goto(cockpit.url);
  await cockpit.session.waitForAttach();

  cockpit.session.emit(status('doom-major-mode', LIVE));
  await expect(page.getByTestId('selection-mode')).toHaveText('COPILOT');
  await page.getByTestId('axis-mode').click();
  await cockpit.session.waitForCommand('prompt');
  await expect(page.getByTestId('axis-mode')).toHaveAttribute('data-pending', 'true');

  // A command that answers with no dialog must not leave the button asking.
  cockpit.session.emit({ type: 'agent_settled' });
  await expect(page.getByTestId('axis-mode')).toHaveAttribute('data-pending', 'false');
});

test('opens the mode menu as the bar popover when the agent answers', async ({ page, cockpit }) => {
  await page.goto(cockpit.url);
  await cockpit.session.waitForAttach();

  cockpit.session.emit(status('doom-major-mode', LIVE));
  await page.getByTestId('axis-mode').click();
  await cockpit.session.waitForCommand('prompt');

  cockpit.session.emit({
    type: 'extension_ui_request',
    id: 'mode-menu',
    method: 'select',
    title: 'pick a major mode',
    options: ['minimal', 'copilot', 'writing'],
  });

  const dialog = page.getByTestId('dialog');
  await expect(dialog).toHaveAttribute('data-dialog-menu', 'mode');
  await expect(page.getByTestId('dialog-title')).toHaveText('MAJOR MODE');

  await page.getByTestId('dialog-option-2').click();
  const answer = await cockpit.session.waitForCommand('extension_ui_response');
  expect(answer.value).toBe('writing');
  await expect(dialog).toBeHidden();
});

test('summarises the minor modes and lists them in the popup', async ({ page, cockpit }) => {
  await page.goto(cockpit.url);
  await cockpit.session.waitForAttach();

  cockpit.session.emit(status('plan-mode'));
  cockpit.session.emit(status('goal', 'ship the parity gate'));

  await expect(page.getByTestId('minor-summary')).toHaveText('goal');

  await page.getByTestId('axis-minor').click();
  await expect(page.getByTestId('minor-popup')).toBeVisible();
  await expect(page.getByTestId('minor-plan')).toHaveAttribute('data-availability', 'off');
  await expect(page.getByTestId('minor-goal')).toHaveAttribute('data-availability', 'on');
  await expect(page.getByTestId('minor-detail-goal')).toHaveText('ship the parity gate');
  await expect(page.getByTestId('minor-loop')).toHaveAttribute('data-availability', 'unavailable');

  await page.keyboard.press('Escape');
  await expect(page.getByTestId('minor-popup')).toBeHidden();
});

test('the journaled catalog drives the popup and rows send /minor for their mode', async ({ page, cockpit }) => {
  await page.goto(cockpit.url);
  await cockpit.session.waitForAttach();

  cockpit.session.emit({
    type: 'entry_appended',
    entry: {
      type: 'custom',
      customType: 'doom-minor-modes',
      data: {
        version: 1,
        revision: 1,
        modes: [
          {
            id: 'help',
            label: 'Help',
            description: '',
            order: 10,
            activation: 'active',
            condition: 'ready',
            actions: [],
          },
          {
            id: 'loop.active',
            label: 'Loop',
            description: '',
            order: 30,
            activation: 'inactive',
            condition: 'ready',
            actions: [],
          },
        ],
      },
    },
  });

  // Help publishes no status, yet the catalog says it is on.
  await expect(page.getByTestId('minor-summary')).toHaveText('help');
  await page.getByTestId('axis-minor').click();
  await expect(page.getByTestId('minor-help')).toHaveAttribute('data-availability', 'on');
  await expect(page.getByTestId('minor-loop')).toHaveAttribute('data-availability', 'off');
  await expect(page.getByTestId('minor-plan')).toHaveAttribute('data-availability', 'unavailable');

  // A row hands its catalog id to /minor and the popup closes.
  await page.getByTestId('minor-loop').click();
  const prompt = await cockpit.session.waitForCommand('prompt');
  expect(prompt.message).toBe('/minor loop.active');
  await expect(page.getByTestId('minor-popup')).toBeHidden();
});

test('clearing a mode status turns it back off in the open popup', async ({ page, cockpit }) => {
  await page.goto(cockpit.url);
  await cockpit.session.waitForAttach();

  cockpit.session.emit(status('doom-loop', 'every 5m'));
  await page.getByTestId('axis-minor').click();
  await expect(page.getByTestId('minor-loop')).toHaveAttribute('data-availability', 'on');

  cockpit.session.emit(status('doom-loop'));
  await expect(page.getByTestId('minor-loop')).toHaveAttribute('data-availability', 'off');
});

test('a minor mode opt-in question opens on the minor chip, not in the middle', async ({ page, cockpit }) => {
  await page.goto(cockpit.url);
  await cockpit.session.waitForAttach();

  cockpit.session.emit(status('plan-mode'));
  await expect(page.getByTestId('minor-plan')).toHaveCount(0);
  await page.getByTestId('axis-minor').click();
  await expect(page.getByTestId('minor-plan')).toHaveAttribute('data-availability', 'off');
  await page.getByTestId('minor-plan').click();

  const prompt = await cockpit.session.waitForCommand('prompt');
  expect(prompt.message).toBe('/minor plan');
  await expect(page.getByTestId('minor-popup')).toBeHidden();

  // The runtime answers a multi-opt-in mode with a picker. It was asked from
  // the bar, so it belongs on the bar.
  cockpit.session.emit({
    type: 'extension_ui_request',
    id: 'plan-flavor',
    method: 'select',
    title: 'Activate: Flavor',
    options: ['Normal', 'Debug', 'Fable'],
  });

  const dialog = page.getByTestId('dialog');
  await expect(dialog).toHaveAttribute('data-dialog-menu', 'minor');
  await expect(page.getByTestId('dialog-title')).toHaveText('MINOR MODES');

  await page.getByTestId('dialog-option-1').click();
  const answer = await cockpit.session.waitForCommand('extension_ui_response');
  expect(answer.value).toBe('Debug');
  await expect(dialog).toBeHidden();
});

test('escaping a minor opt-in question tells the agent and leaves the bar alone', async ({ page, cockpit }) => {
  await page.goto(cockpit.url);
  await cockpit.session.waitForAttach();

  cockpit.session.emit(status('plan-mode'));
  await page.getByTestId('axis-minor').click();
  await expect(page.getByTestId('minor-plan')).toHaveAttribute('data-availability', 'off');
  await page.getByTestId('minor-plan').click();
  await cockpit.session.waitForCommand('prompt');

  cockpit.session.emit({
    type: 'extension_ui_request',
    id: 'plan-flavor-2',
    method: 'select',
    title: 'Activate: Flavor',
    options: ['Normal', 'Debug'],
  });
  await expect(page.getByTestId('dialog')).toBeVisible();

  await page.keyboard.press('Escape');

  // An unanswered request would strand the run, so escape cancels it out loud.
  const answer = await cockpit.session.waitForCommand('extension_ui_response');
  expect(answer.cancelled).toBe(true);
  await expect(page.getByTestId('dialog')).toBeHidden();
  await expect(page.getByTestId('minor-popup')).toBeHidden();
});

test('a mode that cannot run here is offered as unavailable, with the reason', async ({ page, cockpit }) => {
  await page.goto(cockpit.url);
  await cockpit.session.waitForAttach();

  // The runtime journals its catalog, which says per action whether it can run
  // here. Autonomous voice captures from the terminal's own microphone, so it
  // refuses a cockpit and says so.
  cockpit.session.emit({
    type: 'entry_appended',
    entry: {
      type: 'custom',
      id: 'cat-1',
      customType: 'doom-minor-modes',
      data: {
        version: 1,
        revision: 1,
        modes: [
          {
            id: 'voice-auto',
            label: 'Voice',
            description: 'autonomous capture',
            order: 30,
            activation: 'inactive',
            condition: 'ready',
            actions: [
              {
                id: 'activate',
                label: 'Activate',
                description: '',
                needsInput: false,
                enabled: false,
                disabledReason: 'Autonomous voice requires an interactive session.',
              },
            ],
          },
        ],
      },
    },
  });

  await page.getByTestId('axis-minor').click();
  const row = page.getByTestId('minor-voice');
  await expect(row).toHaveAttribute('data-availability', 'unavailable');
  await expect(page.getByTestId('minor-reason-voice')).toHaveText('Autonomous voice requires an interactive session.');

  // The row cannot be clicked into a dead end that answers only after a round trip.
  await expect(row).toBeDisabled();
});
