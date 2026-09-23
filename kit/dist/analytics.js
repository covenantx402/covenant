"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.analyticsRouter = analyticsRouter;
const express_1 = require("express");
function checkAuth(req, token) {
    if (!token)
        return true;
    const header = req.headers["authorization"];
    return typeof header === "string" && header === `Bearer ${token}`;
}
function analyticsRouter(opts) {
    const router = (0, express_1.Router)();
    router.get("/metrics", (req, res) => {
        if (!checkAuth(req, opts.authToken)) {
            return res.status(401).json({ error: "unauthorized" });
        }
        const since = Number(req.query.since ?? 0);
        const summary = opts.logger.getSummary(since);
        res.json(summary);
    });
    router.get("/events", (req, res) => {
        if (!checkAuth(req, opts.authToken)) {
            return res.status(401).json({ error: "unauthorized" });
        }
        const limit = Math.min(Number(req.query.limit ?? 50), 500);
        const events = opts.logger.recentEvents(limit);
        res.json({ events });
    });
    router.get("/health", (_req, res) => {
        res.json({ ok: true, ts: Date.now() });
    });
    return router;
}
