export type Network = "base" | "base-sepolia" | "polygon" | "arbitrum" | "optimism" | "robinhood";
export declare const CHAIN_IDS: Record<Network, number>;
/** Stablecoin per network. Robinhood settles in USDG (6 decimals), not USDC. */
export declare const USDC_ADDRESSES: Record<Network, string>;
export declare const ASSET_META: Record<Network, {
    name: string;
    version: string;
}>;
export interface RoutePricing {
    /** USD amount as decimal string (e.g., "0.10" for 10 cents) */
    price: string;
    /** Description shown to client */
    description?: string;
    /** Optional: override default network */
    network?: Network;
    /** Optional: per-route asset override (defaults to USDC) */
    asset?: string;
    /** Max seconds the payment authorization is valid */
    maxTimeoutSeconds?: number;
}
export interface PaywallConfig {
    /** Wallet address that receives payments */
    payTo: string;
    /** Default network for all routes */
    network: Network;
    /** Facilitator base URL (defaults to https://facilitator.x402.org) */
    facilitatorUrl?: string;
    /** Routes to paywall, keyed by "METHOD /path" */
    routes: Record<string, RoutePricing>;
    /** Path to SQLite db file (defaults to ./x402-kit.db) */
    dbPath?: string;
    /** Webhook URL called after each successful settlement */
    settlementWebhook?: string;
}
export interface PaymentRequirements {
    scheme: "exact";
    network: Network;
    maxAmountRequired: string;
    resource: string;
    description: string;
    mimeType: string;
    payTo: string;
    maxTimeoutSeconds: number;
    asset: string;
    extra?: {
        name: string;
        version: string;
    };
}
export interface PaymentRequiredResponse {
    x402Version: 1;
    accepts: PaymentRequirements[];
    error?: string;
}
export interface ExactEvmAuthorization {
    from: string;
    to: string;
    value: string;
    validAfter: string;
    validBefore: string;
    nonce: string;
}
export interface ExactEvmPayload {
    signature: string;
    authorization: ExactEvmAuthorization;
}
export interface PaymentPayload {
    x402Version: 1;
    scheme: "exact";
    network: Network;
    payload: ExactEvmPayload;
}
export interface VerifyResponse {
    isValid: boolean;
    invalidReason?: string;
    payer?: string;
}
export interface SettleResponse {
    success: boolean;
    errorReason?: string;
    payer?: string;
    transaction?: string;
    network?: string;
}
export interface UsageEvent {
    timestamp: number;
    route: string;
    method: string;
    payer: string | null;
    amountUsd: string;
    network: Network;
    status: "paid" | "rejected" | "free";
    reason: string | null;
    txHash: string | null;
    responseMs: number;
}
