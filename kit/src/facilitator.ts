import type {
  PaymentPayload,
  PaymentRequirements,
  VerifyResponse,
  SettleResponse,
} from "./types.js";

export class FacilitatorClient {
  constructor(private readonly baseUrl: string) {}

  async verify(
    payload: PaymentPayload,
    requirements: PaymentRequirements,
  ): Promise<VerifyResponse> {
    const res = await fetch(`${this.baseUrl}/verify`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        x402Version: 1,
        paymentPayload: payload,
        paymentRequirements: requirements,
      }),
    });
    if (!res.ok) {
      return {
        isValid: false,
        invalidReason: `facilitator /verify HTTP ${res.status}`,
      };
    }
    return (await res.json()) as VerifyResponse;
  }

  async settle(
    payload: PaymentPayload,
    requirements: PaymentRequirements,
  ): Promise<SettleResponse> {
    const res = await fetch(`${this.baseUrl}/settle`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        x402Version: 1,
        paymentPayload: payload,
        paymentRequirements: requirements,
      }),
    });
    if (!res.ok) {
      return {
        success: false,
        errorReason: `facilitator /settle HTTP ${res.status}`,
      };
    }
    return (await res.json()) as SettleResponse;
  }
}
