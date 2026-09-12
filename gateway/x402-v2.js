// x402 Protocol v2 adapter — dual-mode with legacy v1.
//
// TRIBUTE's routes historically emitted v1-only PaymentRequired bodies
// (`maxAmountRequired`, JSON-body challenge). The ecosystem moved to v2 in
// Dec 2025: challenge now travels in a base64 `PAYMENT-REQUIRED` header,
// price field renamed `maxAmountRequired` -> `amount`, and discovery is a
// first-class `extensions.bazaar` block instead of an OpenAPI-only hack.
//
// This module builds a v2-shaped PaymentRequired object from the same route
// data TRIBUTE already tracks, and encodes it with the official
// `@x402/core` codec so third-party clients/scanners that only read the v2
// header get a byte-for-byte spec-compliant payload. v1 emission in
// server.js is untouched — every 402 response now carries BOTH transports.
const { encodePaymentRequiredHeader } = require('@x402/core/http')

/**
 * Build a v2 PaymentRequirements entry (the elements of `accepts[]`).
 * Mirrors the v1 `requirement()` shape in x402-routes.js/marketplace.js but
 * with v2 field names (`amount` instead of `maxAmountRequired`) and no
 * `resource`/`description`/`mimeType` (those move to the top-level
 * `resource` object in v2, added by buildV2Response below).
 */
function acceptV2({ scheme = 'exact', network, amount, payTo, asset, maxTimeoutSeconds = 60, extra }) {
  return {
    scheme,
    network,
    amount: String(amount),
    asset,
    payTo,
    maxTimeoutSeconds,
    extra: extra || undefined,
  }
}

/**
 * Build a full v2 PaymentRequired body + its `extensions.bazaar` discovery
 * block, and the base64 header ready to attach as `PAYMENT-REQUIRED`.
 *
 * @param {object} p
 * @param {string} p.resourceUrl - absolute URL of the paid route
 * @param {string} p.description
 * @param {string} p.mimeType
 * @param {Array}  p.accepts - array of acceptV2(...) entries
 * @param {object} [p.bazaarInput] - { type:'http', method:'GET', queryParams?, bodyFields? }
 * @param {object} [p.bazaarOutput] - example/schema of the 200 payload
 */
function buildV2Response({ resourceUrl, description, mimeType, accepts, bazaarInput, bazaarOutput }) {
  const body = {
    x402Version: 2,
    error: 'PAYMENT_REQUIRED',
    resource: {
      url: resourceUrl,
      description,
      mimeType,
    },
    accepts,
    extensions: {
      bazaar: {
        info: {
          input: bazaarInput || { type: 'http', method: 'GET' },
          output: bazaarOutput,
        },
      },
    },
  }
  let header = null
  try {
    header = encodePaymentRequiredHeader(body)
  } catch (e) {
    console.error('x402 v2 header encode failed:', e.message)
  }
  return { body, header }
}

module.exports = { acceptV2, buildV2Response }
