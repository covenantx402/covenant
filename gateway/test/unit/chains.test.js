// test/unit/chains.test.js — unit tests for chains.js (chain registry).
'use strict'
const assert = require('assert')
const chains = require('../../chains')

let pass = 0
const ok = (name) => { pass++; console.log('  ✓', name) }

// -- all 4 supported chains are registered with the shape callers rely on --
{
  const list = chains.listChains()
  assert.strictEqual(list.length, 4, 'exactly 4 chains registered')
  const ids = list.map(c => c.id).sort((a, b) => a - b)
  assert.deepStrictEqual(ids, [1, 4663, 8453, 42161], 'ids are Ethereum/Robinhood/Base/Arbitrum')
  for (const c of list) {
    assert.ok(/^0x[0-9a-fA-F]{40}$/.test(c.usdc), `${c.key}: usdc address is a valid 0x address`)
    assert.strictEqual(c.decimals, 6, `${c.key}: decimals must be 6 (everything downstream assumes this)`)
    assert.ok(c.rpcEnv.startsWith('COVENANT_RPC_'), `${c.key}: rpcEnv follows the COVENANT_RPC_* convention`)
  }
  ok('all 4 chains have valid usdc address, 6 decimals, correct rpcEnv naming')
}

// -- Robinhood 4663 is the default --
{
  assert.strictEqual(chains.DEFAULT_CHAIN_ID, 4663)
  ok('Robinhood (4663) is DEFAULT_CHAIN_ID')
}

// -- isSupported: numeric, string, and unsupported ids --
{
  assert.strictEqual(chains.isSupported(4663), true)
  assert.strictEqual(chains.isSupported('4663'), true, 'accepts string chain id (comes from query params)')
  assert.strictEqual(chains.isSupported(1), true)
  assert.strictEqual(chains.isSupported(999999), false, 'unregistered id -> false, not throw')
  assert.strictEqual(chains.isSupported('bnb'), false, 'BNB was deliberately excluded (see chains.js comment) — must stay unsupported')
  ok('isSupported correctly accepts numeric/string ids and rejects unknown ones')
}

// -- getChain: returns the right record, throws (not undefined) for unknown --
{
  const c = chains.getChain(8453)
  assert.strictEqual(c.key, 'base')
  assert.strictEqual(c.name, 'Base')
  assert.throws(() => chains.getChain(999999), /unsupported chain id/, 'getChain throws a clear error for an unknown id instead of returning undefined')
  ok('getChain returns the correct record and throws clearly for unknown ids')
}

// -- no two chains accidentally share a usdc address (copy-paste hazard) --
{
  const list = chains.listChains()
  const addrs = list.map(c => c.usdc.toLowerCase())
  assert.strictEqual(new Set(addrs).size, addrs.length, 'every chain has a distinct usdc address — a duplicate would mean settlement on the wrong chain')
  ok('no two chains share the same usdc contract address')
}

// -- every chain has a minSettlePriceUsd, and it's never negative --
{
  const list = chains.listChains()
  for (const c of list) {
    assert.ok(typeof c.minSettlePriceUsd === 'number', `${c.key}: minSettlePriceUsd must be a number`)
    assert.ok(c.minSettlePriceUsd >= 0, `${c.key}: minSettlePriceUsd must not be negative`)
  }
  ok('every chain has a non-negative minSettlePriceUsd')
}

// -- clearsSettleFloor: the actual gate used before every settlement --
{
  // Robinhood's floor is 0 — anything settles, including free/$0.
  assert.strictEqual(chains.clearsSettleFloor(0, 4663), true, 'Robinhood: $0 clears a $0 floor')
  assert.strictEqual(chains.clearsSettleFloor(0.001, 4663), true, 'Robinhood: any positive price clears')
  // Ethereum has the highest floor (most expensive settlement gas).
  assert.strictEqual(chains.clearsSettleFloor(0.01, 1), false, '$0.01 is below Ethereum\'s $0.05 floor — must reject')
  assert.strictEqual(chains.clearsSettleFloor(0.05, 1), true, 'exactly at the floor clears (>=, not >)')
  assert.strictEqual(chains.clearsSettleFloor(1, 1), true, 'well above the floor clears')
  // Base/Arbitrum: cheaper rails, lower floors than Ethereum.
  assert.strictEqual(chains.clearsSettleFloor(0.005, 8453), false, 'below Base\'s floor — reject')
  assert.strictEqual(chains.clearsSettleFloor(0.01, 8453), true, 'at Base\'s floor — clears')
  assert.ok(chains.getChain(1).minSettlePriceUsd > chains.getChain(8453).minSettlePriceUsd,
    'Ethereum L1 floor must be higher than Base L2 floor — gas cost ordering must stay correct if prices are retuned')
  ok('clearsSettleFloor correctly gates prices against each chain\'s settlement-cost floor')
}

console.log(`\nUNIT PASS (chains) — ${pass} checks`)
