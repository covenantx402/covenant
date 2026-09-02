// examples/paid-api.js — run a paid endpoint on the TRIBUTE gateway.
// Assumes the gateway is running (node gateway/server.js) on 127.0.0.1:8792.
//
// 1. Register a paid route:
curl_example() {} // (illustrative — see commands below)

/*
# Register a route priced at 0.01 USDG:
curl -X POST http://127.0.0.1:8792/x402/apis \
  -H 'content-type: application/json' \
  -d '{"path":"/alerts","price":"0.01","description":"TRIBUTE whale alerts","payTo":"0xYOUR_WALLET"}'

# Unpaid client call returns 402 + requirements:
curl http://127.0.0.1:8792/x402/api/alerts

# A paying client signs a PaymentIntent and settles via POST /facilitator/settle.
# After settlement the gateway serves the resource (see examples/pay.js).
*/
