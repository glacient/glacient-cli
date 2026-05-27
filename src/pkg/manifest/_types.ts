export interface ConnectBinding {
  service: string; // e.g. "pinger.PingerService"
  method: string; // e.g. "ListWorkflows"
  /** URL path prefix under which the Connect handler is mounted, e.g. "/api". */
  path_prefix?: string;
}

export type CapabilityEntry = {
  id: string;
  summary: string;
  version: string;
  related_capabilities: string[];
};

export type Manifest = {
  manifest_version: string;
  capabilities: CapabilityEntry[];
};

export type CacheStatus = {
  status: "fresh" | "stale" | "missing";
  version?: string;
  fetched_at?: string;
};
