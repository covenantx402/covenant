import { Router } from "express";
import type { UsageLogger } from "./usage-logger.js";
export interface AnalyticsRouterOptions {
    logger: UsageLogger;
    /** Optional bearer token to gate the endpoint */
    authToken?: string;
}
export declare function analyticsRouter(opts: AnalyticsRouterOptions): Router;
