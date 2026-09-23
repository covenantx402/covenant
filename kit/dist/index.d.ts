import type { Express } from "express";
import { FacilitatorClient } from "./facilitator.js";
import { UsageLogger } from "./usage-logger.js";
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
export declare function install(app: Express, opts: InstallOptions): InstallHandle;
export { paywall } from "./middleware.js";
export { analyticsRouter } from "./analytics.js";
export { FacilitatorClient } from "./facilitator.js";
export { UsageLogger } from "./usage-logger.js";
export { loadConfigFromFile, validateConfig } from "./config.js";
export * from "./types.js";
