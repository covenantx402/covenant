import type { Express } from "express";
import { paywall } from "./middleware.js";
import { analyticsRouter } from "./analytics.js";
import { FacilitatorClient } from "./facilitator.js";
import { UsageLogger } from "./usage-logger.js";
import { loadConfigFromFile, validateConfig } from "./config.js";
import type { PaywallConfig } from "./types.js";

export interface InstallOptions {
  /** Path to YAML config, or an in-memory config object */
  config: string | PaywallConfig;
  /** Mount point for analytics router (default: /__x402) */
  analyticsPath?: string;
  /** Bearer token to gate the analytics endpoints */
  analyticsAuthToken?: string;
}

export interface InstallHandle {
  logger: UsageLogger;
  facilitator: FacilitatorClient;
  config: PaywallConfig;
  close: () => void;
}

/**
 * Install x402-kit on an existing Express app.
 *
 * - Mounts the paywall middleware at the top of the request chain
 * - Mounts /__x402/metrics, /__x402/events, /__x402/health
 *
 * Returns a handle so callers can close the SQLite connection on shutdown.
 */
export function install(app: Express, opts: InstallOptions): InstallHandle {
  const config =
    typeof opts.config === "string"
      ? loadConfigFromFile(opts.config)
      : validateConfig(opts.config);

  const logger = new UsageLogger(config.dbPath ?? "./x402-kit.db");
  const facilitator = new FacilitatorClient(
    config.facilitatorUrl ?? "https://facilitator.x402.org",
  );

  app.use(paywall({ config, logger, facilitator }));
  app.use(
    opts.analyticsPath ?? "/__x402",
    analyticsRouter({ logger, authToken: opts.analyticsAuthToken }),
  );

  return {
    logger,
    facilitator,
    config,
    close: () => logger.close(),
  };
}

export { paywall } from "./middleware.js";
export { analyticsRouter } from "./analytics.js";
export { FacilitatorClient } from "./facilitator.js";
export { UsageLogger } from "./usage-logger.js";
export { loadConfigFromFile, validateConfig } from "./config.js";
export * from "./types.js";
