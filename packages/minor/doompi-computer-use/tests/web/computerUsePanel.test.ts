import { bindSessionApiWorkspace } from '@agimon-ai/doompi-core/web';
import { beforeEach as beforeEachApiRoutes } from 'vitest';
beforeEachApiRoutes(() => bindSessionApiWorkspace(() => 'test-workspace'));
import { driveChannel, renderPlugin, slotPropsFixture } from '@agimon-ai/doompi-core/webTesting';
import { afterEach, describe, expect, it } from 'vitest';

import { webPlugin as scopedWebPlugin } from '../../generated/web';
import {
  computerUse,
  computerUseChannel,
} from '../../src/extensions/workspaces/sessions/(frontend)/_lib/computerUseStore';
const webPlugin = {
  id: scopedWebPlugin.id,
  ...scopedWebPlugin.global,
  ...scopedWebPlugin.workspace,
  ...scopedWebPlugin.session,
};

afterEach(() => computerUse.reset());

const render = () => renderPlugin(webPlugin.fills![0]!.component!, slotPropsFixture({ sessionId: 's1' }).props);

describe('computer-use panel', () => {
  it('offers Mac window selection without requiring a remote window list', () => {
    driveChannel(computerUseChannel, 's1', {
      state: { sessionId: 's1', revision: 1, wake: 1, phase: 'inactive' },
      targets: [],
    });
    const rendered = render();
    expect(rendered.error).toBeUndefined();
    expect(rendered.html).toContain('Choose window on Mac');
    expect(rendered.html).not.toContain('disabled=""');
  });

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
        artifact: {
          artifactId: 'artifact-1',
          status: 'ready',
          actionCount: 4,
          sizeBytes: 11,
        },
      },
      targets: [],
    });
    expect(render().html).toContain('Completed recording');
    expect(render().html).toContain('Actions:');
    // Static markup cannot run the sealed download effect or prove playback.
    expect(render().html).toContain('Loading recording through the secure channel.');
    expect(render().html).not.toContain('<video');
    expect(render().html).not.toContain('href="/api/');
  });

  it('registers as a default-off minor mode and Activity section without a permanent tab', () => {
    expect(webPlugin.tabs).toBeUndefined();
    expect(webPlugin.minorModes).toEqual([
      expect.objectContaining({
        name: 'computer use',
        modeId: 'computer-use',
        statusKey: 'doom-computer-use-mode',
        hideWhenMissing: true,
      }),
    ]);
    expect(webPlugin.settingsSections).toEqual([
      expect.objectContaining({
        id: 'computer-use',
        fields: [expect.objectContaining({ kind: 'toggle', keyPath: ['computerUse', 'enabled'] })],
      }),
    ]);
    expect(webPlugin.activityGroups).toEqual([
      expect.objectContaining({ name: 'computer-use', statusKey: 'doom-computer-use', hideWhenEmpty: true }),
    ]);
    expect(webPlugin.fills?.[0]?.component).toBeDefined();
    expect(webPlugin.toolRenderers?.flatMap((renderer) => renderer.tools ?? [])).toEqual([
      'computer_action',
      'computer_exec',
      'computer_state',
    ]);
  });
});
