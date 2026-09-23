"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __exportStar = (this && this.__exportStar) || function(m, exports) {
    for (var p in m) if (p !== "default" && !Object.prototype.hasOwnProperty.call(exports, p)) __createBinding(exports, m, p);
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.validateConfig = exports.loadConfigFromFile = exports.UsageLogger = exports.FacilitatorClient = exports.analyticsRouter = exports.paywall = void 0;
exports.install = install;
const middleware_js_1 = require("./middleware.js");
const analytics_js_1 = require("./analytics.js");
const facilitator_js_1 = require("./facilitator.js");
const usage_logger_js_1 = require("./usage-logger.js");
const config_js_1 = require("./config.js");
/**
 * Install x402-kit on an existing Express app.
 *
 * - Mounts the paywall middleware at the top of the request chain
 * - Mounts /__x402/metrics, /__x402/events, /__x402/health
 *
 * Returns a handle so callers can close the SQLite connection on shutdown.
 */
function install(app, opts) {
    const config = typeof opts.config === "string"
        ? (0, config_js_1.loadConfigFromFile)(opts.config)
        : (0, config_js_1.validateConfig)(opts.config);
    const logger = new usage_logger_js_1.UsageLogger(config.dbPath ?? "./x402-kit.db");
    const facilitator = new facilitator_js_1.FacilitatorClient(config.facilitatorUrl ?? "https://facilitator.x402.org");
    app.use((0, middleware_js_1.paywall)({ config, logger, facilitator }));
    app.use(opts.analyticsPath ?? "/__x402", (0, analytics_js_1.analyticsRouter)({ logger, authToken: opts.analyticsAuthToken }));
    return {
        logger,
        facilitator,
        config,
        close: () => logger.close(),
    };
}
var middleware_js_2 = require("./middleware.js");
Object.defineProperty(exports, "paywall", { enumerable: true, get: function () { return middleware_js_2.paywall; } });
var analytics_js_2 = require("./analytics.js");
Object.defineProperty(exports, "analyticsRouter", { enumerable: true, get: function () { return analytics_js_2.analyticsRouter; } });
var facilitator_js_2 = require("./facilitator.js");
Object.defineProperty(exports, "FacilitatorClient", { enumerable: true, get: function () { return facilitator_js_2.FacilitatorClient; } });
var usage_logger_js_2 = require("./usage-logger.js");
Object.defineProperty(exports, "UsageLogger", { enumerable: true, get: function () { return usage_logger_js_2.UsageLogger; } });
var config_js_2 = require("./config.js");
Object.defineProperty(exports, "loadConfigFromFile", { enumerable: true, get: function () { return config_js_2.loadConfigFromFile; } });
Object.defineProperty(exports, "validateConfig", { enumerable: true, get: function () { return config_js_2.validateConfig; } });
__exportStar(require("./types.js"), exports);
