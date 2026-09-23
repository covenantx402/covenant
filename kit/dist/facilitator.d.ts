import type { PaymentPayload, PaymentRequirements, VerifyResponse, SettleResponse } from "./types.js";
export declare class FacilitatorClient {
    private readonly baseUrl;
    constructor(baseUrl: string);
    verify(payload: PaymentPayload, requirements: PaymentRequirements): Promise<VerifyResponse>;
    settle(payload: PaymentPayload, requirements: PaymentRequirements): Promise<SettleResponse>;
}
