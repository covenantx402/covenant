"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.loadConfigFromFile = loadConfigFromFile;
exports.validateConfig = validateConfig;
const node_fs_1 = require("node:fs");
const yaml_1 = require("yaml");
const VALID_NETWORKS = [
    "base",
    "base-sepolia",
    "polygon",
    "arbitrum",
    "optimism",
    "robinhood",
];
function loadConfigFromFile(path) {
    const raw = (0, node_fs_1.readFileSync)(path, "utf8");
    const parsed = (0, yaml_1.parse)(raw);
    return validateConfig(parsed);
}
function validateConfig(input) {
    if (!input || typeof input !== "object") {
        throw new Error("x402-kit config must be an object");
    }
    const c = input;
    if (typeof c.payTo !== "string" || !/^0x[0-9a-fA-F]{40}$/.test(c.payTo)) {
        throw new Error("config.payTo must be a 0x-prefixed 40-hex-char Ethereum address");
    }
    if (typeof c.network !== "string" || !VALID_NETWORKS.includes(c.network)) {
        throw new Error(`config.network must be one of: ${VALID_NETWORKS.join(", ")}`);
    }
    if (!c.routes || typeof c.routes !== "object") {
        throw new Error("config.routes must be an object");
    }
    for (const [routeKey, value] of Object.entries(c.routes)) {
        if (!/^[A-Z]+ \/.*/.test(routeKey)) {
            throw new Error(`route key "${routeKey}" must be of form "METHOD /path" (e.g., "GET /weather")`);
        }
        const r = value;
        if (typeof r.price !== "string" || !/^\d+(\.\d{1,6})?$/.test(r.price)) {
            throw new Error(`route "${routeKey}" price must be a decimal string with up to 6 decimal places (e.g., "0.10")`);
        }
    }
    return {
        payTo: c.payTo,
        network: c.network,
        facilitatorUrl: typeof c.facilitatorUrl === "string"
            ? c.facilitatorUrl
            : "https://facilitator.x402.org",
        routes: c.routes,
        dbPath: typeof c.dbPath === "string" ? c.dbPath : "./x402-kit.db",
        settlementWebhook: typeof c.settlementWebhook === "string" ? c.settlementWebhook : undefined,
    };
}
