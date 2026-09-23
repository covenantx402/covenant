import type { RequestHandler } from "express";
import { FacilitatorClient } from "./facilitator.js";
import { UsageLogger } from "./usage-logger.js";
import { type ExactEvmAuthorization, type Network, type PaymentPayload, type PaymentRequirements, type PaywallConfig, type RoutePricing } from "./types.js";
/**
 * Convert a USD decimal string ("0.10") into the atomic-unit string
 * expected by EIP-3009 for USDC (6 decimals → "100000").
 */
declare function priceToAtomic(usdPrice: string): string;
declare function atomicToUsd(atomic: string): string;
declare function buildRequirements(pricing: RoutePricing, config: PaywallConfig, resourceUrl: string): PaymentRequirements;
declare function decodePayload(headerValue: string): PaymentPayload | null;
declare function matchAuthorization(auth: ExactEvmAuthorization, requirements: PaymentRequirements): {
    ok: true;
} | {
    ok: false;
    reason: string;
};
export interface PaywallMiddlewareDeps {
    config: PaywallConfig;
    logger: UsageLogger;
    facilitator: FacilitatorClient;
    /** Override Date.now in tests */
    now?: () => number;
}
export declare function paywall(deps: PaywallMiddlewareDeps): RequestHandler;
export declare const internals: {
    priceToAtomic: typeof priceToAtomic;
    atomicToUsd: typeof atomicToUsd;
    decodePayload: typeof decodePayload;
    matchAuthorization: typeof matchAuthorization;
    buildRequirements: typeof buildRequirements;
    CHAIN_IDS: Record<Network, number>;
};
export {};
