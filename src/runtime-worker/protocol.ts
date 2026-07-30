export interface RuntimeWorkerBootstrapOptions {
  readonly homeDir?: string;
  readonly profile?: string;
  readonly sessionsDir?: string;
  readonly defaultProvider?: string;
  readonly defaultModel?: string;
  readonly permissionTimeoutMs?: number;
  /** Worker-owner bootstrap permission to load the configured outbound A2A integration. */
  readonly configuredA2A?: boolean;
}

export interface RuntimeWorkerResourceLimits {
  readonly maxOldGenerationSizeMb?: number;
  readonly maxYoungGenerationSizeMb?: number;
  readonly stackSizeMb?: number;
}

export interface RuntimeWorkerOptions {
  readonly resourceLimits?: RuntimeWorkerResourceLimits;
  readonly shutdownTimeoutMs?: number;
  /**
   * Load `<homeDir>/.kodax/integrations/a2a.json` inside the Worker owner.
   * Defaults to false so SDK hosts explicitly opt into ambient user integration.
   */
  readonly configuredA2A?: boolean;
}
