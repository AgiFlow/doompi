import type {
  DoomHeadlessClient,
  DoomHeadlessExecutionContext,
  DoomHeadlessHostService,
} from '../../src/exports/headless.ts';

// Compile-only fixture included by the native typecheck target, never imported at runtime.
// Removing a boundary makes its @ts-expect-error unused and fails that target.
declare const client: DoomHeadlessClient;
declare const execution: DoomHeadlessExecutionContext;
declare const host: DoomHeadlessHostService;

client.setStatus('fixture', 'ready');
void client.request({ kind: 'input', title: 'Fixture question' });
void execution.session.appendCustomEntry('fixture', { retained: true });
void host.select({ majorMode: 'development', domains: [], minorModes: [] });

// @ts-expect-error Pi widgets are not part of the headless client.
client.setWidget('fixture', []);
// @ts-expect-error Pi editors cannot be emulated by the headless client.
client.editor('Fixture editor');
// @ts-expect-error Arbitrary Pi custom UI is not a headless interaction.
client.custom(() => undefined);
// @ts-expect-error Explicit client requests cannot request a Pi widget.
void client.request({ kind: 'widget', title: 'Not a headless interaction' });
// @ts-expect-error Headless execution contexts do not expose Pi's UI facade.
void execution.ui;
// @ts-expect-error A host service must not smuggle widgets around its typed client.
host.setWidget('fixture', []);
// @ts-expect-error A host service must not smuggle an editor around its typed client.
host.editor('Fixture editor');
// @ts-expect-error A host service must not expose arbitrary custom Pi rendering.
host.custom(() => undefined);
