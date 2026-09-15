/** Telemetry events this package reports, and the port that records them. */
export const DOMAIN_EVENT = {
  domainsSwitched: 'doom_pi_domains.switched',
  domainsSwitchFailed: 'doom_pi_domains.switch_failed',
} as const;

export type DomainEventName = (typeof DOMAIN_EVENT)[keyof typeof DOMAIN_EVENT];
export type DomainEventAttributes = Record<string, string | number | boolean>;

export interface DomainTelemetry {
  recordError(event: DomainEventName, error: unknown, attributes?: DomainEventAttributes): Promise<void>;
  recordEvent(event: DomainEventName, attributes?: DomainEventAttributes): Promise<void>;
}
