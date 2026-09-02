import { readFileSync } from "node:fs";
import { parse as parseYaml } from "yaml";
import type { PaywallConfig, Network } from "./types.js";

const VALID_NETWORKS: Network[] = [
  "base",
  "base-sepolia",
  "polygon",
  "arbitrum",
  "optimism",
  "robinhood",
];

export function loadConfigFromFile(path: string): PaywallConfig {
  const raw = readFileSync(path, "utf8");
  const parsed = parseYaml(raw);
  return validateConfig(parsed);
}

export function validateConfig(input: unknown): PaywallConfig {
  if (!input || typeof input !== "object") {
    throw new Error("x402-kit config must be an object");
  }
  const c = input as Record<string, unknown>;

  if (typeof c.payTo !== "string" || !/^0x[0-9a-fA-F]{40}$/.test(c.payTo)) {
    throw new Error(
      "config.payTo must be a 0x-prefixed 40-hex-char Ethereum address",
    );
  }
  if (typeof c.network !== "string" || !VALID_NETWORKS.includes(c.network as Network)) {
    throw new Error(
      `config.network must be one of: ${VALID_NETWORKS.join(", ")}`,
    );
  }
  if (!c.routes || typeof c.routes !== "object") {
    throw new Error("config.routes must be an object");
  }
  for (const [routeKey, value] of Object.entries(
    c.routes as Record<string, unknown>,
  )) {
    if (!/^[A-Z]+ \/.*/.test(routeKey)) {
      throw new Error(
        `route key "${routeKey}" must be of form "METHOD /path" (e.g., "GET /weather")`,
      );
    }
    const r = value as Record<string, unknown>;
    if (typeof r.price !== "string" || !/^\d+(\.\d{1,6})?$/.test(r.price)) {
      throw new Error(
        `route "${routeKey}" price must be a decimal string with up to 6 decimal places (e.g., "0.10")`,
      );
    }
  }

  return {
    payTo: c.payTo,
    network: c.network as Network,
    facilitatorUrl:
      typeof c.facilitatorUrl === "string"
        ? c.facilitatorUrl
        : "https://facilitator.x402.org",
    routes: c.routes as PaywallConfig["routes"],
    dbPath: typeof c.dbPath === "string" ? c.dbPath : "./x402-kit.db",
    settlementWebhook:
      typeof c.settlementWebhook === "string" ? c.settlementWebhook : undefined,
  };
}
