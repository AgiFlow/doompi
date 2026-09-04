import { driveChannel, renderPlugin, slotPropsFixture } from '@agimon-ai/doompi-web-contracts/testing';
import { afterEach, describe, expect, it } from 'vitest';
import { computerUse, computerUseChannel } from '../../src/web/computerUseStore.ts';
import { webPlugin } from '../../src/web/index.ts';

afterEach(() => computerUse.reset());

const render = () => renderPlugin(webPlugin.tabs![0]!.panel, slotPropsFixture({ sessionId: 's1' }).props);

describe('computer-use panel', () => {
  it('renders target activation controls for an inactive session', () => {
    driveChannel(computerUseChannel, 's1', {
      state: { sessionId: 's1', revision: 1, wake: 1, phase: 'inactive' },
      targets: [{ windowId: 'w1', applicationName: 'Fixture' }],
    });
    const rendered = render();
    expect(rendered.error).toBeUndefined();
    expect(rendered.html).toContain('Request activation');
    expect(rendered.html).toContain('Fixture');
  });

  it('renders pending activation and completed artifact metadata', () => {
    driveChannel(computerUseChannel, 's1', {
      state: { sessionId: 's1', revision: 2, wake: 2, phase: 'awaiting_confirmation' },
      targets: [],
    });
    expect(render().html).toContain('Desktop activation is pending');

    driveChannel(computerUseChannel, 's1', {
      state: {
        sessionId: 's1',
        revision: 3,
        wake: 3,
        phase: 'inactive',
        artifact: { artifactId: 'artifact-1', status: 'ready', actionCount: 4 },
      },
      targets: [],
    });
    expect(render().html).toContain('Completed artifact');
    expect(render().html).toContain('Actions:');
  });

  it('registers both tool cards', () => {
    expect(webPlugin.toolRenderers?.flatMap((renderer) => renderer.tools ?? [])).toEqual([
      'computer_state',
      'computer_action',
    ]);
  });
});
