export interface RuntimeWorkerBootstrapOptions {
  readonly homeDir?: string;
  readonly profile?: string;
  readonly sessionsDir?: string;
  readonly defaultProvider?: string;
  readonly defaultModel?: string;
  readonly permissionTimeoutMs?: number;
}

export interface RuntimeWorkerResourceLimits {
  readonly maxOldGenerationSizeMb?: number;
  readonly maxYoungGenerationSizeMb?: number;
  readonly stackSizeMb?: number;
}

export interface RuntimeWorkerOptions {
  readonly resourceLimits?: RuntimeWorkerResourceLimits;
  readonly shutdownTimeoutMs?: number;
}
