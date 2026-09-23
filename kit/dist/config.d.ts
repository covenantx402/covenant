import type { PaywallConfig } from "./types.js";
export declare function loadConfigFromFile(path: string): PaywallConfig;
export declare function validateConfig(input: unknown): PaywallConfig;
