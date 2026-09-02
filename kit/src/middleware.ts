import type { Request, Response, NextFunction, RequestHandler } from "express";
import { FacilitatorClient } from "./facilitator.js";
import { UsageLogger } from "./usage-logger.js";
import {
  CHAIN_IDS,
  USDC_ADDRESSES,
  ASSET_META,
  type ExactEvmAuthorization,
  type Network,
  type PaymentPayload,
  type PaymentRequirements,
  type PaymentRequiredResponse,
  type PaywallConfig,
  type RoutePricing,
} from "./types.js";

const X402_VERSION = 1;
/** USDC has 6 decimals on every supported network. */
const USDC_DECIMALS = 6;

/**
 * Convert a USD decimal string ("0.10") into the atomic-unit string
 * expected by EIP-3009 for USDC (6 decimals → "100000").
 */
function priceToAtomic(usdPrice: string): string {
  const [whole, frac = ""] = usdPrice.split(".");
  const padded = (frac + "0".repeat(USDC_DECIMALS)).slice(0, USDC_DECIMALS);
  const combined = (whole + padded).replace(/^0+(?=\d)/, "");
  return combined === "" ? "0" : combined;
}

function atomicToUsd(atomic: string): string {
  if (atomic.length <= USDC_DECIMALS) {
    return ("0." + atomic.padStart(USDC_DECIMALS, "0")).replace(/0+$/, "0");
  }
  const split = atomic.length - USDC_DECIMALS;
  return atomic.slice(0, split) + "." + atomic.slice(split);
}

function buildRequirements(
  pricing: RoutePricing,
  config: PaywallConfig,
  resourceUrl: string,
): PaymentRequirements {
  const network = pricing.network ?? config.network;
  const asset = pricing.asset ?? USDC_ADDRESSES[network];
  return {
    scheme: "exact",
    network,
    maxAmountRequired: priceToAtomic(pricing.price),
    resource: resourceUrl,
    description: pricing.description ?? `Access to ${resourceUrl}`,
    mimeType: "application/json",
    payTo: config.payTo,
    maxTimeoutSeconds: pricing.maxTimeoutSeconds ?? 60,
    asset,
    extra: ASSET_META[network],
  };
}

function decodePayload(headerValue: string): PaymentPayload | null {
  try {
    const json = Buffer.from(headerValue, "base64").toString("utf8");
    const parsed = JSON.parse(json) as PaymentPayload;
    if (
      parsed.x402Version !== X402_VERSION ||
      parsed.scheme !== "exact" ||
      typeof parsed.network !== "string" ||
      !parsed.payload?.signature ||
      !parsed.payload?.authorization
    ) {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

function matchAuthorization(
  auth: ExactEvmAuthorization,
  requirements: PaymentRequirements,
): { ok: true } | { ok: false; reason: string } {
  if (auth.to.toLowerCase() !== requirements.payTo.toLowerCase()) {
    return { ok: false, reason: "authorization.to does not match payTo" };
  }
  if (BigInt(auth.value) < BigInt(requirements.maxAmountRequired)) {
    return { ok: false, reason: "authorization.value below maxAmountRequired" };
  }
  const now = Math.floor(Date.now() / 1000);
  if (Number(auth.validBefore) <= now) {
    return { ok: false, reason: "authorization expired" };
  }
  if (Number(auth.validAfter) > now) {
    return { ok: false, reason: "authorization not yet valid" };
  }
  return { ok: true };
}

export interface PaywallMiddlewareDeps {
  config: PaywallConfig;
  logger: UsageLogger;
  facilitator: FacilitatorClient;
  /** Override Date.now in tests */
  now?: () => number;
}

export function paywall(deps: PaywallMiddlewareDeps): RequestHandler {
  const { config, logger, facilitator } = deps;
  const now = deps.now ?? (() => Date.now());

  return async (req: Request, res: Response, next: NextFunction) => {
    const startedAt = now();
    const routeKey = `${req.method.toUpperCase()} ${req.path}`;
    const pricing = config.routes[routeKey];

    if (!pricing) {
      logger.log({
        timestamp: startedAt,
        route: req.path,
        method: req.method,
        payer: null,
        amountUsd: "0",
        network: config.network,
        status: "free",
        reason: null,
        txHash: null,
        responseMs: 0,
      });
      return next();
    }

    const protocol = (req.headers["x-forwarded-proto"] as string) ?? req.protocol;
    const host = req.headers.host ?? "localhost";
    const resourceUrl = `${protocol}://${host}${req.originalUrl}`;
    const requirements = buildRequirements(pricing, config, resourceUrl);
    const network = requirements.network;

    const send402 = (errorReason?: string): void => {
      const body: PaymentRequiredResponse = {
        x402Version: X402_VERSION,
        accepts: [requirements],
        ...(errorReason ? { error: errorReason } : {}),
      };
      logger.log({
        timestamp: startedAt,
        route: req.path,
        method: req.method,
        payer: null,
        amountUsd: pricing.price,
        network,
        status: "rejected",
        reason: errorReason ?? "missing X-PAYMENT header",
        txHash: null,
        responseMs: now() - startedAt,
      });
      res.status(402).json(body);
    };

    const headerVal = req.headers["x-payment"];
    if (typeof headerVal !== "string" || headerVal.length === 0) {
      return send402();
    }

    const payload = decodePayload(headerVal);
    if (!payload) {
      return send402("malformed X-PAYMENT header");
    }
    if (payload.network !== network) {
      return send402(
        `network mismatch: requested ${network}, payload was ${payload.network}`,
      );
    }

    const localCheck = matchAuthorization(payload.payload.authorization, requirements);
    if (!localCheck.ok) {
      return send402(localCheck.reason);
    }

    const verify = await facilitator.verify(payload, requirements);
    if (!verify.isValid) {
      return send402(verify.invalidReason ?? "facilitator verification failed");
    }
    const payer = verify.payer ?? payload.payload.authorization.from;

    res.once("finish", () => {
      void (async () => {
        let txHash: string | null = null;
        let status: "paid" | "rejected" = "paid";
        let reason: string | null = null;
        try {
          const settle = await facilitator.settle(payload, requirements);
          if (!settle.success) {
            status = "rejected";
            reason = settle.errorReason ?? "facilitator settlement failed";
          } else {
            txHash = settle.transaction ?? null;
            if (config.settlementWebhook) {
              try {
                await fetch(config.settlementWebhook, {
                  method: "POST",
                  headers: { "content-type": "application/json" },
                  body: JSON.stringify({
                    route: req.path,
                    method: req.method,
                    payer,
                    amountUsd: pricing.price,
                    network,
                    txHash,
                    timestamp: startedAt,
                  }),
                });
              } catch (err) {
                reason = `webhook error: ${(err as Error).message}`;
              }
            }
          }
        } catch (err) {
          status = "rejected";
          reason = `settle threw: ${(err as Error).message}`;
        }

        logger.log({
          timestamp: startedAt,
          route: req.path,
          method: req.method,
          payer,
          amountUsd: pricing.price,
          network,
          status,
          reason,
          txHash,
          responseMs: now() - startedAt,
        });
      })();
    });

    next();
  };
}

export const internals = {
  priceToAtomic,
  atomicToUsd,
  decodePayload,
  matchAuthorization,
  buildRequirements,
  CHAIN_IDS,
};
