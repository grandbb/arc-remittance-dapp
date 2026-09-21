"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const http = require("node:http");
const path = require("node:path");
const { MAINNET: DEX_MAINNET } = require("./dex");

const ROOT = __dirname;
const NETWORKS = Object.freeze({
  mainnet: Object.freeze({
    name: "Arc Mainnet",
    chainId: 5042,
    rpcUrl: "https://rpc.mainnet.arc.io",
    explorerUrl: "https://explorer.arc.io",
    usdc: "0x3600000000000000000000000000000000000000",
    eurc: "0xbEf5f6d51CB62b58e6A8f77868681825C6fe21c1",
  }),
  testnet: Object.freeze({
    name: "Arc Testnet",
    chainId: 5042002,
    rpcUrl: "https://rpc.testnet.arc.io",
    explorerUrl: "https://explorer.testnet.arc.io",
    usdc: "0x3600000000000000000000000000000000000000",
    eurc: "0x89B50855Aa3bE2F677cD6303Cec089B5F319D72a",
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
  const remittanceAddress = String(env.ARC_REMITTANCE_ADDRESS || "").trim();
  if (remittanceAddress && !isAddress(remittanceAddress)) {
    throw new Error("ARC_REMITTANCE_ADDRESS must be a valid EVM contract address");
  }
  return {
    networkName,
    network: NETWORKS[networkName],
    liquiditySource: networkName === "mainnet" ? "uniswap-v3" : "inventory",
    remittanceAddress,
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

function isAddress(value) {
  return typeof value === "string" && /^0x[a-fA-F0-9]{40}$/.test(value) && !/^0x0{40}$/i.test(value);
}

function createHandler(options = {}) {
  const config = options.config || getRuntimeConfig();

  return async function handler(req, res) {
    const requestId = crypto.randomUUID();
    const securityHeaders = {
      "Content-Security-Policy": "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; connect-src 'self' https://rpc.mainnet.arc.io https://rpc.testnet.arc.io; img-src 'self' data:; object-src 'none'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'",
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

      if (req.method === "GET" && url.pathname === "/api/config") {
        return sendJson(res, 200, {
          network: config.networkName,
          ...config.network,
          liquiditySource: config.liquiditySource || "inventory",
          dex: config.liquiditySource === "uniswap-v3" ? DEX_MAINNET : null,
          remittanceAddress: config.remittanceAddress,
          remittanceConfigured: Boolean(config.remittanceAddress),
        });
      }

      if (req.method === "GET" && url.pathname === "/api/health") {
        return sendJson(res, 200, { ok: true, network: config.networkName,
          liquiditySource: config.liquiditySource || "inventory",
          swapConfigured: config.liquiditySource === "uniswap-v3" || Boolean(config.remittanceAddress),
          remittanceConfigured: Boolean(config.remittanceAddress) });
      }

      const staticFiles = { "/": "index.html", "/index.html": "index.html", "/app.js": "app.js", "/dex.js": "dex.js", "/vendor/ethers.js": "node_modules/ethers/dist/ethers.umd.min.js", "/api/vendor/ethers.js": "node_modules/ethers/dist/ethers.umd.min.js" };
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
    const address = server.address();
    const port = typeof address === "object" && address ? address.port : config.port;
    console.log(`ArcFX listening on http://localhost:${port} (${config.network.name})`);
    if (config.liquiditySource === "inventory" && !config.remittanceAddress) console.warn("ARC_REMITTANCE_ADDRESS is not set; testnet inventory swaps are disabled.");
  });
  return server;
}

if (require.main === module) start();

module.exports = { NETWORKS, createHandler, getRuntimeConfig, loadEnv, start };
