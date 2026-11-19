export interface MagpieCacheWindow {
  from: string;
  to: string;
  requests: number;
  input: number;
  cached: number;
  hitRequests: number;
  ratio: number | null;
  requestHitRatio: number | null;
}

export interface MagpieCacheModel {
  provider: string;
  model: string;
  status: 'healthy' | 'watching' | 'degraded' | 'insufficient';
  incidentOpen: boolean;
  lastValidAt: string | null;
  window: MagpieCacheWindow | null;
  reference: MagpieCacheWindow | null;
}

export interface MagpieCacheSummary {
  version: 1;
  checkedAt: string;
  lastValidAt: string | null;
  models: MagpieCacheModel[];
  sourceStatus: 'ok' | 'unavailable' | 'incomplete';
}
