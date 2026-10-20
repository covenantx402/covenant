import type { Request, Response, NextFunction, RequestHandler } from "express";
import { createHmac, timingSafeEqual } from "node:crypto";
import { FacilitatorClient } from "./facilitator.js";
import { UsageLogger } from "./usage-logger.js";
import {
  CHAIN_IDS,
  USDC_ADDRESSES,
  ASSET_META,
  type ExactEvmAuthorization,
  type PaymentPayload,
  type PaymentRequirements,
  type PaymentRequiredResponse,
  type PaywallConfig,
  type RoutePricing,
} from "./types.js";

const X402_VERSION = 1;
/** USDC has 6 decimals on every supported network. */
const USDC_DECIMALS = 6;
// Used/in-flight payment nonces (kept for the process lifetime, bounded). Per-process: run one instance or
// share this via the facilitator, which also enforces nonce uniqueness on its side.
const usedNonces = new Set<string>();
const NONCE_CAP = 100_000;
function claimNonce(k: string): boolean {
  if (usedNonces.has(k)) return false;
  if (usedNonces.size >= NONCE_CAP) usedNonces.delete(usedNonces.values().next().value as string);
  usedNonces.add(k);
  return true;
}
function releaseNonce(k: string): void { usedNonces.delete(k); }
const WEBHOOK_MAX_ATTEMPTS = 3;
const WEBHOOK_BASE_DELAY_MS = 250;

function signWebhookBody(body: string, secret: string, ts?: string): string {
  // With a timestamp the signature covers `${ts}.${body}` so a captured webhook cannot be replayed later.
  return "sha256=" + createHmac("sha256", secret).update(ts ? `${ts}.${body}` : body).digest("hex");
}
const WEBHOOK_MAX_SKEW_MS = 5 * 60 * 1000;

/**
 * Verify an inbound webhook signature header (for receivers built with
 * x402-kit on both ends). Uses a constant-time comparison to avoid leaking
 * timing information about the expected signature.
 */
export function verifyWebhookSignature(
  rawBody: string,
  signatureHeader: string | undefined,
  secret: string,
  timestampHeader?: string,
  nowMs: number = Date.now(),
): boolean {
  if (!signatureHeader) return false;
  // When a timestamp is supplied it must be fresh (anti-replay) and is covered by the signature.
  if (timestampHeader !== undefined) {
    const t = Number(timestampHeader);
    if (!Number.isFinite(t) || Math.abs(nowMs - t) > WEBHOOK_MAX_SKEW_MS) return false;
  }
  const expected = signWebhookBody(rawBody, secret, timestampHeader);
  const a = Buffer.from(expected);
  const b = Buffer.from(signatureHeader);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

async function deliverWebhook(
  url: string,
  body: string,
  secret: string | undefined,
): Promise<void> {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (!/^https:\/\//i.test(url) && !/^http:\/\/(localhost|127\.0\.0\.1)(:|\/|$)/i.test(url)) {
    throw new Error("settlementWebhook must be https");
  }
  if (secret) {
    const ts = String(Date.now());
    headers["x-covenant-timestamp"] = ts;
    headers["x-covenant-signature"] = signWebhookBody(body, secret, ts);
  }

  let lastErr: Error | undefined;
  for (let attempt = 1; attempt <= WEBHOOK_MAX_ATTEMPTS; attempt++) {
    try {
      const res = await fetch(url, { method: "POST", headers, body, redirect: "error", signal: AbortSignal.timeout(5000) });
      if (res.ok) return;
      lastErr = new Error(`webhook responded ${res.status}`);
    } catch (err) {
      lastErr = err as Error;
    }
    if (attempt < WEBHOOK_MAX_ATTEMPTS) {
      await new Promise((r) => setTimeout(r, WEBHOOK_BASE_DELAY_MS * 2 ** (attempt - 1)));
    }
  }
  throw lastErr ?? new Error("webhook delivery failed");
}

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

function validAuthorization(a: unknown): boolean {
  if (!a || typeof a !== "object") return false;
  const x = a as Record<string, unknown>;
  return (
    typeof x.from === "string" && /^0x[0-9a-fA-F]{40}$/.test(x.from) &&
    typeof x.to === "string" && /^0x[0-9a-fA-F]{40}$/.test(x.to) &&
    typeof x.value === "string" && /^\d{1,40}$/.test(x.value) &&
    (typeof x.validAfter === "string" || typeof x.validAfter === "number") && /^\d{1,20}$/.test(String(x.validAfter)) &&
    (typeof x.validBefore === "string" || typeof x.validBefore === "number") && /^\d{1,20}$/.test(String(x.validBefore)) &&
    typeof x.nonce === "string" && /^0x[0-9a-fA-F]{64}$/.test(x.nonce)
  );
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
      !parsed.payload?.authorization ||
      !validAuthorization(parsed.payload.authorization)
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

const _canon = new WeakMap<object, Record<string, RoutePricing>>();
function routeTable(config: PaywallConfig): Record<string, RoutePricing> {
  let t = _canon.get(config.routes);
  if (!t) {
    t = {};
    for (const [k, v] of Object.entries(config.routes)) {
      const i = k.indexOf(" ");
      const m = k.slice(0, i).toUpperCase();
      const p = k.slice(i + 1);
      t[`${m} ${(p.length > 1 ? p.replace(/\/+$/, "") : p).toLowerCase()}`] = v;
    }
    _canon.set(config.routes, t);
  }
  return t;
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
    // Express matches paths case-insensitively and ignores a trailing slash, and runs GET handlers for HEAD.
    // Canonicalise the same way before the lookup or `/Weather`, `/weather/` and HEAD skip the paywall.
    const method = req.method.toUpperCase() === "HEAD" ? "GET" : req.method.toUpperCase();
    let canonPath = req.path;
    try { canonPath = decodeURIComponent(canonPath); } catch { /* keep raw */ }
    canonPath = (canonPath.length > 1 ? canonPath.replace(/\/+$/, "") : canonPath).toLowerCase();
    const routeKey = `${method} ${canonPath}`;
    const pricing = routeTable(config)[routeKey];

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

    const publicOrigin = config.publicOrigin;
    const protocol = req.protocol; // honours Express "trust proxy"; never trust a raw client header
    const host = req.headers.host ?? "localhost";
    const resourceUrl = publicOrigin ? `${publicOrigin.replace(/\/+$/, "")}${req.originalUrl}` : `${protocol}://${host}${req.originalUrl}`;
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

    const auth = payload.payload.authorization;
    const nonceKey = `${network}:${auth.nonce.toLowerCase()}`;
    if (!claimNonce(nonceKey)) {
      return send402("payment nonce already used or in flight");
    }
    let settledOk = false;
    try {
      const localCheck = matchAuthorization(auth, requirements);
      if (!localCheck.ok) return send402(localCheck.reason);

      const verify = await facilitator.verify(payload, requirements);
      if (!verify.isValid) {
        return send402(verify.invalidReason ?? "facilitator verification failed");
      }
      const payer = verify.payer ?? auth.from;

      // Settle BEFORE delivering. Previously settlement ran after the response finished and its failure was
      // swallowed, so a replayed/unfundable header got the resource for free.
      let txHash: string | null = null;
      const settle = await facilitator.settle(payload, requirements);
      if (!settle.success) {
        return send402(settle.errorReason ?? "facilitator settlement failed");
      }
      settledOk = true;
      txHash = settle.transaction ?? null;
      res.setHeader("X-PAYMENT-RESPONSE", Buffer.from(JSON.stringify({ success: true, transaction: txHash, network, payer })).toString("base64"));

      logger.log({
        timestamp: startedAt,
        route: req.path,
        method: req.method,
        payer,
        amountUsd: pricing.price,
        network,
        status: "paid",
        reason: null,
        txHash,
        responseMs: now() - startedAt,
      });

      if (config.settlementWebhook) {
        const body = JSON.stringify({
          route: req.path,
          method: req.method,
          payer,
          amountUsd: pricing.price,
          network,
          txHash,
          timestamp: startedAt,
        });
        void deliverWebhook(config.settlementWebhook, body, config.settlementWebhookSecret).catch((err) => {
          logger.log({ timestamp: startedAt, route: req.path, method: req.method, payer, amountUsd: pricing.price, network, status: "paid", reason: `webhook error: ${(err as Error).message}`, txHash, responseMs: now() - startedAt });
        });
      }
    } catch (err) {
      return send402(`payment processing failed: ${(err as Error).message}`);
    } finally {
      // A settled nonce stays consumed (replay guard); a failed one is released so a legit retry works.
      if (!settledOk) releaseNonce(nonceKey);
    }

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
