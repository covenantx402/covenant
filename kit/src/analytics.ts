import { Router, type Request, type Response } from "express";
import type { UsageLogger } from "./usage-logger.js";

export interface AnalyticsRouterOptions {
  logger: UsageLogger;
  /** Optional bearer token to gate the endpoint */
  authToken?: string;
}

function checkAuth(req: Request, token: string | undefined): boolean {
  if (!token) return true;
  const header = req.headers["authorization"];
  return typeof header === "string" && header === `Bearer ${token}`;
}

export function analyticsRouter(opts: AnalyticsRouterOptions): Router {
  const router = Router();

  router.get("/metrics", (req: Request, res: Response) => {
    if (!checkAuth(req, opts.authToken)) {
      return res.status(401).json({ error: "unauthorized" });
    }
    const since = Number(req.query.since ?? 0);
    const summary = opts.logger.getSummary(since);
    res.json(summary);
  });

  router.get("/events", (req: Request, res: Response) => {
    if (!checkAuth(req, opts.authToken)) {
      return res.status(401).json({ error: "unauthorized" });
    }
    const limit = Math.min(Number(req.query.limit ?? 50), 500);
    const events = opts.logger.recentEvents(limit);
    res.json({ events });
  });

  router.get("/health", (_req: Request, res: Response) => {
    res.json({ ok: true, ts: Date.now() });
  });

  return router;
}
