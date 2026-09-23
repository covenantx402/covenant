"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.FacilitatorClient = void 0;
class FacilitatorClient {
    baseUrl;
    constructor(baseUrl) {
        this.baseUrl = baseUrl;
    }
    async verify(payload, requirements) {
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
        return (await res.json());
    }
    async settle(payload, requirements) {
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
        return (await res.json());
    }
}
exports.FacilitatorClient = FacilitatorClient;
