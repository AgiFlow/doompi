export interface SinkStatus {
  service: string;
  backend: string;
  endpoint: string;
  endpointSource: string;
  traces: boolean;
  redaction: boolean;
  fileFallback: boolean;
}
