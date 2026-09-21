export interface SessionView {
  sessionId: string;
  revision: number;
  repositoryName: string;
  profile: string | null;
  majorMode: string;
  domains: string[];
  layers: string[];
  minorModes: string[];
}
