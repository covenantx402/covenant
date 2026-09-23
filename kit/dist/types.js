"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.ASSET_META = exports.USDC_ADDRESSES = exports.CHAIN_IDS = void 0;
exports.CHAIN_IDS = {
    base: 8453,
    "base-sepolia": 84532,
    polygon: 137,
    arbitrum: 42161,
    optimism: 10,
    robinhood: 4663,
};
/** Stablecoin per network. Robinhood settles in USDG (6 decimals), not USDC. */
exports.USDC_ADDRESSES = {
    base: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
    "base-sepolia": "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
    polygon: "0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359",
    arbitrum: "0xaf88d065e77c8cC2239327C5EDb3A432268e5831",
    optimism: "0x0b2C639c533813f4Aa9D7837CAf62653d097Ff85",
    robinhood: "0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168",
};
exports.ASSET_META = {
    base: { name: "USD Coin", version: "2" },
    "base-sepolia": { name: "USD Coin", version: "2" },
    polygon: { name: "USD Coin", version: "2" },
    arbitrum: { name: "USD Coin", version: "2" },
    optimism: { name: "USD Coin", version: "2" },
    robinhood: { name: "USDG", version: "2" },
};
