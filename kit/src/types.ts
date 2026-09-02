export type Network =
  | "base"
  | "base-sepolia"
  | "polygon"
  | "arbitrum"
  | "optimism"
  | "robinhood";

export const CHAIN_IDS: Record<Network, number> = {
  base: 8453,
  "base-sepolia": 84532,
  polygon: 137,
  arbitrum: 42161,
  optimism: 10,
  robinhood: 4663,
};

/** Stablecoin per network. Robinhood settles in USDG (6 decimals), not USDC. */
export const USDC_ADDRESSES: Record<Network, string> = {
  base: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
  "base-sepolia": "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
  polygon: "0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359",
  arbitrum: "0xaf88d065e77c8cC2239327C5EDb3A432268e5831",
  optimism: "0x0b2C639c533813f4Aa9D7837CAf62653d097Ff85",
  robinhood: "0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168",
};

export const ASSET_META: Record<Network, { name: string; version: string }> = {
  base: { name: "USD Coin", version: "2" },
  "base-sepolia": { name: "USD Coin", version: "2" },
  polygon: { name: "USD Coin", version: "2" },
  arbitrum: { name: "USD Coin", version: "2" },
  optimism: { name: "USD Coin", version: "2" },
  robinhood: { name: "USDG", version: "2" },
};

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
