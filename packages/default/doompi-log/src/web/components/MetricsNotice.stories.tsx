/*
 * Plain CSF objects; the style-system renderer resolves the default export by
 * finding a bare `const meta`, so it is not named at the point of definition.
 *
 * This module has no single `MetricsNotice` component: it exports the two
 * things the page says instead of, or above, a report. `component` names the
 * one with variants worth comparing; both are drawn below.
 */
import { EmptyForReason, FocusNotice } from './MetricsNotice';

const meta = {
  title: 'Log/MetricsNotice',
  component: FocusNotice,
  tags: ['style-system'],
};

export default meta;

export const Playground = {
  render: () => (
    <div className="flex flex-col gap-6 bg-doom-bg p-6">
      <div className="flex flex-col gap-2">
        <span className="text-2xs text-doom-dim uppercase tracking-widest">empty · no sink installed</span>
        <EmptyForReason
          response={{
            unavailable: 'no-sink',
            detail: 'No log sink is installed on this machine, so nothing is recorded.',
          }}
        />
      </div>

      <div className="flex flex-col gap-2">
        <span className="text-2xs text-doom-dim uppercase tracking-widest">empty · sink with nothing in it</span>
        <EmptyForReason
          response={{ unavailable: 'no-data', detail: 'The log sink is installed but has not recorded a turn yet.' }}
        />
      </div>

      <div className="flex flex-col gap-2">
        <span className="text-2xs text-doom-dim uppercase tracking-widest">empty · package api not mounted</span>
        <EmptyForReason
          response={{
            unavailable: 'no-api',
            detail: 'This cockpit is running a bundle without the log package API, so there are no metrics to read.',
          }}
        />
      </div>

      <div className="flex flex-col gap-2">
        <span className="text-2xs text-doom-dim uppercase tracking-widest">focus · applied</span>
        <FocusNotice
          requested="claude-sonnet-4-5"
          applied="claude-sonnet-4-5"
          dimension="model"
          onClear={() => undefined}
        />
      </div>

      <div className="flex flex-col gap-2">
        <span className="text-2xs text-doom-dim uppercase tracking-widest">focus · refused by an older sink</span>
        <FocusNotice requested="claude-sonnet-4-5" applied={undefined} dimension="model" onClear={() => undefined} />
      </div>

      <div className="flex flex-col gap-2">
        <span className="text-2xs text-doom-dim uppercase tracking-widest">
          focus · nothing requested, renders null
        </span>
        <FocusNotice requested="" applied={undefined} dimension="session" onClear={() => undefined} />
      </div>
    </div>
  ),
};
