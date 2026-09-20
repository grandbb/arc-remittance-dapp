"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const http = require("node:http");
const path = require("node:path");

const ROOT = __dirname;
const MAX_BODY_BYTES = 64 * 1024;
const REQUEST_TIMEOUT_MS = 15_000;
const RATE_WINDOW_MS = 60_000;
const RATE_LIMIT = 60;

const NETWORKS = Object.freeze({
  mainnet: Object.freeze({
    name: "Arc Mainnet",
    chainId: 5042,
    rpcUrl: "https://rpc.mainnet.arc.io",
    explorerUrl: "https://explorer.arc.io",
    usdc: "0x3600000000000000000000000000000000000000",
    eurc: "0xbEf5f6d51CB62b58e6A8f77868681825C6fe21c1",
    permit2: "0x000000000022D473030F116dDEE9F6B43aC78BA3",
    fxEscrow: "0xe2E5F173576B513d994073CCbDaCBE027d43DFe6",
  }),
  testnet: Object.freeze({
    name: "Arc Testnet",
    chainId: 5042002,
    rpcUrl: "https://rpc.testnet.arc.io",
    explorerUrl: "https://explorer.testnet.arc.io",
    usdc: "0x3600000000000000000000000000000000000000",
    eurc: "0x89B50855Aa3bE2F677cD6303Cec089B5F319D72a",
    permit2: "0x000000000022D473030F116dDEE9F6B43aC78BA3",
    fxEscrow: "0x867650F5eAe8df91445971f14d89fd84F0C9a9f8",
  }),
});

function loadEnv(file = path.join(ROOT, ".env")) {
  if (!fs.existsSync(file)) return;
  for (const line of fs.readFileSync(file, "utf8").split(/\r?\n/)) {
    const match = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
    if (!match || process.env[match[1]] !== undefined) continue;
    let value = match[2];
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    process.env[match[1]] = value;
  }
}

function getRuntimeConfig(env = process.env) {
  const networkName = String(env.ARC_NETWORK || "mainnet").toLowerCase();
  if (!NETWORKS[networkName]) throw new Error("ARC_NETWORK must be mainnet or testnet");
  const apiBaseUrl = env.CIRCLE_API_BASE_URL || (networkName === "mainnet" ? "https://api.circle.com" : "https://api-sandbox.circle.com");
  const parsedBase = new URL(apiBaseUrl);
  if (parsedBase.protocol !== "https:") throw new Error("CIRCLE_API_BASE_URL must use HTTPS");
  return {
    networkName,
    network: NETWORKS[networkName],
    apiBaseUrl: parsedBase.origin,
    apiKey: env.CIRCLE_API_KEY || "",
    allowedOrigins: new Set(String(env.ALLOWED_ORIGINS || "").split(",").map((item) => item.trim()).filter(Boolean)),
    port: Number(env.PORT || 3000),
  };
}

function sendJson(res, status, payload, extraHeaders = {}) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(body),
    "Cache-Control": "no-store",
    ...extraHeaders,
  });
  res.end(body);
}

async function readJson(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) {
      const error = new Error("Request body is too large");
      error.status = 413;
      throw error;
    }
    chunks.push(chunk);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
  } catch {
    const error = new Error("Request body must be valid JSON");
    error.status = 400;
    throw error;
  }
}

function isAddress(value) {
  return typeof value === "string" && /^0x[a-fA-F0-9]{40}$/.test(value);
}

function isUuid(value) {
  return typeof value === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

function validateQuote(body) {
  const currencies = new Set(["USDC", "EURC"]);
  const from = body?.from;
  const to = body?.to;
  if (!currencies.has(from?.currency) || !currencies.has(to?.currency) || from.currency === to.currency) {
    throw Object.assign(new Error("Only USDC/EURC and EURC/USDC quotes are supported"), { status: 400 });
  }
  if (!/^\d+(\.\d{1,6})?$/.test(String(from.amount || "")) || Number(from.amount) <= 0) {
    throw Object.assign(new Error("Amount must be a positive decimal with at most 6 places"), { status: 400 });
  }
  if (!isAddress(body.recipientAddress)) {
    throw Object.assign(new Error("A valid recipientAddress is required"), { status: 400 });
  }
  return {
    from: { currency: from.currency, amount: String(from.amount) },
    to: { currency: to.currency },
    tenor: "instant",
    type: "tradable",
    recipientAddress: body.recipientAddress,
  };
}

function validateTrade(body) {
  if (!isUuid(body?.quoteId) || !isAddress(body?.address) || typeof body?.signature !== "string" || !/^0x[0-9a-f]+$/i.test(body.signature)) {
    throw Object.assign(new Error("Invalid trade payload"), { status: 400 });
  }
  if (!body.message || typeof body.message !== "object" || Array.isArray(body.message)) {
    throw Object.assign(new Error("The signed quote message is required"), { status: 400 });
  }
  return {
    idempotencyKey: isUuid(body.idempotencyKey) ? body.idempotencyKey : crypto.randomUUID(),
    quoteId: body.quoteId,
    address: body.address,
    message: body.message,
    signature: body.signature,
  };
}

function validatePresign(body) {
  const id = String(body?.contractTradeId || "");
  if (!/^\d+$/.test(id)) throw Object.assign(new Error("A numeric contractTradeId is required"), { status: 400 });
  return { contractTradeIds: [id], type: "taker" };
}

function validateFund(body) {
  if (typeof body?.signature !== "string" || !/^0x[0-9a-f]+$/i.test(body.signature) || !body.permit2 || typeof body.permit2 !== "object") {
    throw Object.assign(new Error("Invalid funding payload"), { status: 400 });
  }
  return { type: "taker", signature: body.signature, permit2: body.permit2 };
}

async function circleRequest(config, fetchImpl, pathname, method, body) {
  if (!config.apiKey) throw Object.assign(new Error("StableFX is not configured. Set CIRCLE_API_KEY on the server."), { status: 503 });
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const response = await fetchImpl(`${config.apiBaseUrl}${pathname}`, {
      method,
      headers: {
        Accept: "application/json",
        Authorization: `Bearer ${config.apiKey}`,
        "Content-Type": "application/json",
        "X-Request-Id": crypto.randomUUID(),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: controller.signal,
    });
    const text = await response.text();
    const data = text ? (() => { try { return JSON.parse(text); } catch { return { message: text }; } })() : {};
    if (!response.ok) {
      const error = new Error(data?.message || data?.error || "Circle API request failed");
      error.status = response.status;
      error.details = data;
      throw error;
    }
    return data?.data ?? data;
  } catch (error) {
    if (error.name === "AbortError") throw Object.assign(new Error("Circle API request timed out"), { status: 504 });
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

function createHandler(options = {}) {
  const config = options.config || getRuntimeConfig();
  const fetchImpl = options.fetchImpl || globalThis.fetch;
  const rateBuckets = new Map();

  return async function handler(req, res) {
    const requestId = crypto.randomUUID();
    const securityHeaders = {
      "Content-Security-Policy": "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; connect-src 'self' https://rpc.mainnet.arc.io https://rpc.testnet.arc.io; img-src 'self' data:; frame-ancestors 'none'; base-uri 'self'; form-action 'self'",
      "Referrer-Policy": "no-referrer",
      "X-Content-Type-Options": "nosniff",
      "X-Frame-Options": "DENY",
      "X-Request-Id": requestId,
    };
    for (const [name, value] of Object.entries(securityHeaders)) res.setHeader(name, value);

    try {
      const url = new URL(req.url, "http://localhost");
      const origin = req.headers.origin;
      const sameHost = origin && (() => { try { return new URL(origin).host === req.headers.host; } catch { return false; } })();
      if (origin && !sameHost && !config.allowedOrigins.has(origin)) {
        throw Object.assign(new Error("Origin is not allowed"), { status: 403 });
      }

      if (url.pathname.startsWith("/api/")) {
        const ip = req.socket.remoteAddress || "unknown";
        const now = Date.now();
        const bucket = rateBuckets.get(ip);
        if (!bucket || now - bucket.startedAt >= RATE_WINDOW_MS) rateBuckets.set(ip, { startedAt: now, count: 1 });
        else if (++bucket.count > RATE_LIMIT) throw Object.assign(new Error("Too many requests"), { status: 429 });
      }

      if (req.method === "GET" && url.pathname === "/api/config") {
        return sendJson(res, 200, {
          network: config.networkName,
          ...config.network,
          stableFxConfigured: Boolean(config.apiKey),
        });
      }

      if (req.method === "GET" && url.pathname === "/api/health") {
        return sendJson(res, 200, { ok: true, network: config.networkName, stableFxConfigured: Boolean(config.apiKey) });
      }

      if (req.method === "POST" && url.pathname === "/api/stablefx/quotes") {
        const result = await circleRequest(config, fetchImpl, "/v1/exchange/stablefx/quotes", "POST", validateQuote(await readJson(req)));
        return sendJson(res, 200, result);
      }
      if (req.method === "POST" && url.pathname === "/api/stablefx/trades") {
        const result = await circleRequest(config, fetchImpl, "/v1/exchange/stablefx/trades", "POST", validateTrade(await readJson(req)));
        return sendJson(res, 200, result);
      }
      if (req.method === "POST" && url.pathname === "/api/stablefx/funding/presign") {
        const result = await circleRequest(config, fetchImpl, "/v1/exchange/stablefx/signatures/funding/presign", "POST", validatePresign(await readJson(req)));
        return sendJson(res, 200, result);
      }
      if (req.method === "POST" && url.pathname === "/api/stablefx/fund") {
        const result = await circleRequest(config, fetchImpl, "/v1/exchange/stablefx/fund", "POST", validateFund(await readJson(req)));
        return sendJson(res, 200, result);
      }
      const tradeMatch = req.method === "GET" && url.pathname.match(/^\/api\/stablefx\/trades\/([0-9a-f-]+)$/i);
      if (tradeMatch) {
        if (!isUuid(tradeMatch[1])) throw Object.assign(new Error("Invalid trade ID"), { status: 400 });
        const result = await circleRequest(config, fetchImpl, `/v1/exchange/stablefx/trades/${tradeMatch[1]}`, "GET");
        return sendJson(res, 200, result);
      }

      const staticFiles = { "/": "index.html", "/index.html": "index.html", "/app.js": "app.js", "/vendor/ethers.js": "node_modules/ethers/dist/ethers.umd.min.js", "/api/vendor/ethers.js": "node_modules/ethers/dist/ethers.umd.min.js" };
      const file = staticFiles[url.pathname];
      if (req.method === "GET" && file) {
        const body = fs.readFileSync(path.join(ROOT, file));
        const type = file.endsWith(".js") ? "text/javascript; charset=utf-8" : "text/html; charset=utf-8";
        const cache = file === "index.html" ? "no-cache" : file.includes("ethers.umd.min.js") ? "public, max-age=31536000, immutable" : "public, max-age=300";
        res.writeHead(200, { "Content-Type": type, "Content-Length": body.length, "Cache-Control": cache });
        return res.end(body);
      }
      sendJson(res, 404, { error: "Not found", requestId });
    } catch (error) {
      const status = Number.isInteger(error.status) && error.status >= 400 && error.status < 600 ? error.status : 500;
      if (status >= 500 && status !== 503) console.error(`[${requestId}]`, error);
      sendJson(res, status, { error: error.message || "Internal server error", requestId });
    }
  };
}

function start() {
  loadEnv();
  const config = getRuntimeConfig();
  const server = http.createServer(createHandler({ config }));
  server.listen(config.port, () => {
    console.log(`ArcFX listening on http://localhost:${config.port} (${config.network.name})`);
    if (!config.apiKey) console.warn("CIRCLE_API_KEY is not set; quote and trade endpoints are disabled.");
  });
  return server;
}

if (require.main === module) start();

module.exports = { NETWORKS, createHandler, getRuntimeConfig, loadEnv, start, validateQuote, validateTrade };
