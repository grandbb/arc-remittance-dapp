const { test } = require("node:test");
const assert = require("node:assert/strict");
const { Interface, ZeroAddress } = require("ethers");
const dex = require("../dex");
const { NETWORKS, getRuntimeConfig } = require("../server");

test("Mainnet uses the existing DEX without an inventory address or API key", () => {
  const config = getRuntimeConfig({ ARC_NETWORK: "mainnet" });
  assert.equal(config.liquiditySource, "uniswap-v3");
  assert.equal(config.remittanceAddress, "");
});

test("router calldata preserves exact amount, minimum and recipient in both directions", () => {
  for (const fromCurrency of ["USDC", "EURC"]) {
    const toCurrency = fromCurrency === "USDC" ? "EURC" : "USDC";
    const recipient = "0x3333333333333333333333333333333333333333";
    const q = { fromCurrency, toCurrency, recipient, amountIn: 100000000n, minAmountOut: 86000000n };
    const data = dex.calls(NETWORKS.mainnet, q);
    const [params] = new Interface(dex.ROUTER_ABI).decodeFunctionData("exactInputSingle", data[0]);
    assert.equal(params.tokenIn.toLowerCase(), NETWORKS.mainnet[fromCurrency.toLowerCase()].toLowerCase());
    assert.equal(params.tokenOut.toLowerCase(), NETWORKS.mainnet[toCurrency.toLowerCase()].toLowerCase());
    assert.equal(params.recipient, recipient);
    assert.equal(params.amountIn, q.amountIn);
    assert.equal(params.amountOutMinimum, q.minAmountOut);
    assert.equal(params.fee, 500n);
    assert.equal(params.sqrtPriceLimitX96, 0n);
    const iface = new Interface(dex.ROUTER_ABI);
    const encoded = iface.encodeFunctionData("multicall", [123456, data]);
    assert.equal(iface.decodeFunctionData("multicall", encoded)[0], 123456n);
  }
});

test("rejects unsafe recipients and zero minimum output", () => {
  const q = { fromCurrency: "USDC", toCurrency: "EURC", amountIn: 100n, minAmountOut: 90n };
  for (const recipient of [ZeroAddress, dex.MAINNET.router, dex.MAINNET.pool, "0x0000000000000000000000000000000000000001"]) {
    assert.throws(() => dex.calls(NETWORKS.mainnet, { ...q, recipient }), /Invalid recipient/);
  }
  assert.throws(() => dex.calls(NETWORKS.testnet, { ...q, recipient: ZeroAddress }), /Mainnet only/);
});
