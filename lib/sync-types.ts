export type SyncPhase = 'local' | 'connecting' | 'syncing' | 'synced' | 'offline' | 'needs-token' | 'error';

export interface SyncPresentation {
  phase: SyncPhase;
  label: string;
  message: string;
}

export interface GitHubConnectInput {
  owner: string;
  repo: string;
  token: string;
}
