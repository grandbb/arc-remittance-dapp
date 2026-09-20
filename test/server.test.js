const assert = require("node:assert/strict");
const http = require("node:http");
const test = require("node:test");
const { NETWORKS, createHandler, getRuntimeConfig, validateQuote } = require("../server");

async function withServer(fetchImpl, callback, apiKey = "TEST:ID:SECRET") {
  const config = {
    networkName: "mainnet",
    network: NETWORKS.mainnet,
    apiBaseUrl: "https://api.circle.test",
    apiKey,
    allowedOrigins: new Set(),
  };
  const server = http.createServer(createHandler({ config, fetchImpl }));
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const address = server.address();
    await callback(`http://127.0.0.1:${address.port}`);
  } finally {
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
}

test("mainnet configuration uses the official Arc network and Circle token addresses", () => {
  const config = getRuntimeConfig({ ARC_NETWORK: "mainnet", CIRCLE_API_KEY: "secret" });
  assert.equal(config.network.chainId, 5042);
  assert.equal(config.network.rpcUrl, "https://rpc.mainnet.arc.io");
  assert.equal(config.network.usdc, "0x3600000000000000000000000000000000000000");
  assert.equal(config.network.eurc, "0xbEf5f6d51CB62b58e6A8f77868681825C6fe21c1");
});

test("quote validation limits the API to USDC/EURC and six decimal places", () => {
  const recipientAddress = "0x1111111111111111111111111111111111111111";
  const quote = validateQuote({ from: { currency: "USDC", amount: "12.345678" }, to: { currency: "EURC" }, recipientAddress });
  assert.deepEqual(quote, { from: { currency: "USDC", amount: "12.345678" }, to: { currency: "EURC" }, tenor: "instant", type: "tradable", recipientAddress });
  assert.throws(() => validateQuote({ from: { currency: "USDT", amount: "1" }, to: { currency: "EURC" }, recipientAddress }), /Only USDC\/EURC/);
  assert.throws(() => validateQuote({ from: { currency: "USDC", amount: "1.0000001" }, to: { currency: "EURC" }, recipientAddress }), /at most 6/);
});

test("config endpoint never exposes the Circle API key", async () => {
  await withServer(async () => { throw new Error("upstream should not be called"); }, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/config`);
    const text = await response.text();
    assert.equal(response.status, 200);
    assert.equal(text.includes("TEST:ID:SECRET"), false);
    assert.equal(JSON.parse(text).stableFxConfigured, true);
  });
});

test("quote endpoint forwards a normalized payload and server-side authorization", async () => {
  let upstream;
  const fetchImpl = async (url, options) => {
    upstream = { url, options };
    return new Response(JSON.stringify({ data: { id: "quote-id", rate: "0.92" } }), { status: 200, headers: { "content-type": "application/json" } });
  };
  await withServer(fetchImpl, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/stablefx/quotes`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ from: { currency: "USDC", amount: "100.00" }, to: { currency: "EURC" }, recipientAddress: "0x1111111111111111111111111111111111111111", ignored: "value" }),
    });
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { id: "quote-id", rate: "0.92" });
  });
  assert.equal(upstream.url, "https://api.circle.test/v1/exchange/stablefx/quotes");
  assert.equal(upstream.options.headers.Authorization, "Bearer TEST:ID:SECRET");
  assert.deepEqual(JSON.parse(upstream.options.body), {
    from: { currency: "USDC", amount: "100.00" },
    to: { currency: "EURC" },
    tenor: "instant",
    type: "tradable",
    recipientAddress: "0x1111111111111111111111111111111111111111",
  });
});

test("trade retries preserve a caller idempotency key", async () => {
  const idempotencyKey = "5d845e06-f78f-4b62-891e-d7a17fe4a115";
  let forwarded;
  const fetchImpl = async (_url, options) => {
    forwarded = JSON.parse(options.body);
    return new Response(JSON.stringify({ data: { id: "7f7188c4-6d4d-49aa-8bea-478ff46bc082" } }), { status: 200 });
  };
  await withServer(fetchImpl, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/stablefx/trades`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        idempotencyKey,
        quoteId: "237f528f-0e69-4527-9826-bf263f4d31f1",
        address: "0x1111111111111111111111111111111111111111",
        message: { permitted: { amount: "1000000" } },
        signature: "0x1234",
      }),
    });
    assert.equal(response.status, 200);
  });
  assert.equal(forwarded.idempotencyKey, idempotencyKey);
});

test("StableFX endpoints remain disabled until a server key is configured", async () => {
  await withServer(async () => { throw new Error("upstream should not be called"); }, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/stablefx/quotes`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ from: { currency: "USDC", amount: "1" }, to: { currency: "EURC" }, recipientAddress: "0x1111111111111111111111111111111111111111" }),
    });
    assert.equal(response.status, 503);
    assert.match((await response.json()).error, /CIRCLE_API_KEY/);
  }, "");
});
