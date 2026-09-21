const assert = require("node:assert/strict");
const http = require("node:http");
const test = require("node:test");
const { NETWORKS, createHandler, getRuntimeConfig } = require("../server");

const REMITTANCE_ADDRESS = "0x1111111111111111111111111111111111111111";

async function withServer(callback, remittanceAddress = REMITTANCE_ADDRESS) {
  const config = {
    networkName: "mainnet",
    network: NETWORKS.mainnet,
    remittanceAddress,
    allowedOrigins: new Set(),
  };
  const server = http.createServer(createHandler({ config }));
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    await callback(`http://127.0.0.1:${server.address().port}`);
  } finally {
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
}

test("mainnet configuration uses the official Arc network and token addresses", () => {
  const config = getRuntimeConfig({ ARC_NETWORK: "mainnet", ARC_REMITTANCE_ADDRESS: REMITTANCE_ADDRESS });
  assert.equal(config.network.chainId, 5042);
  assert.equal(config.network.rpcUrl, "https://rpc.mainnet.arc.io");
  assert.equal(config.network.usdc, "0x3600000000000000000000000000000000000000");
  assert.equal(config.network.eurc, "0xbEf5f6d51CB62b58e6A8f77868681825C6fe21c1");
  assert.equal(config.remittanceAddress, REMITTANCE_ADDRESS);
});

test("configuration rejects an invalid remittance contract address", () => {
  assert.throws(
    () => getRuntimeConfig({ ARC_NETWORK: "mainnet", ARC_REMITTANCE_ADDRESS: "not-an-address" }),
    /valid EVM contract address/,
  );
  assert.throws(
    () => getRuntimeConfig({ ARC_NETWORK: "mainnet", ARC_REMITTANCE_ADDRESS: "0x0000000000000000000000000000000000000000" }),
    /valid EVM contract address/,
  );
});

test("config endpoint exposes only public on-chain configuration", async () => {
  await withServer(async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/config`);
    const data = await response.json();
    assert.equal(response.status, 200);
    assert.equal(data.remittanceConfigured, true);
    assert.equal(data.remittanceAddress, REMITTANCE_ADDRESS);
    assert.equal(Object.hasOwn(data, "apiKey"), false);
    assert.equal(Object.hasOwn(data, "stableFxConfigured"), false);
  });
});

test("the app can start before a remittance contract is deployed", async () => {
  await withServer(async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/config`);
    const data = await response.json();
    assert.equal(response.status, 200);
    assert.equal(data.remittanceConfigured, false);
    assert.equal(data.remittanceAddress, "");
  }, "");
});

test("legacy StableFX proxy endpoints are removed", async () => {
  await withServer(async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/stablefx/quotes`, { method: "POST" });
    assert.equal(response.status, 404);
  });
});

test("Mainnet serves the shared DEX adapter and enables routing without an inventory contract", async () => {
  const server = http.createServer(createHandler({ config: getRuntimeConfig({ ARC_NETWORK: "mainnet" }) }));
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  try {
    const base = `http://127.0.0.1:${server.address().port}`;
    const config = await (await fetch(`${base}/api/config`)).json();
    assert.equal(config.liquiditySource, "uniswap-v3");
    assert.equal(config.dex.fee, 500);
    const adapter = await fetch(`${base}/dex.js`);
    assert.equal(adapter.status, 200);
    assert.match(adapter.headers.get("content-type"), /javascript/);
    assert.match(await adapter.text(), /quoteExactInputSingle/);
    const health = await (await fetch(`${base}/api/health`)).json();
    assert.equal(health.swapConfigured, true);
    assert.equal(health.remittanceConfigured, false);
  } finally { await new Promise(resolve => server.close(resolve)); }
});
