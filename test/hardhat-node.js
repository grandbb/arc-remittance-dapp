"use strict";

const path = require("node:path");
const { spawn } = require("node:child_process");
const { createServer } = require("node:net");

async function availablePort() {
  const server = createServer();
  await new Promise((resolve, reject) => server.listen(0, "127.0.0.1", (error) => error ? reject(error) : resolve()));
  const port = server.address().port;
  await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  return port;
}

async function startHardhatNode() {
  const root = path.resolve(__dirname, "..");
  const port = await availablePort();
  const url = `http://127.0.0.1:${port}`;
  const cli = path.join(root, "node_modules", "hardhat", "dist", "src", "cli.js");
  const child = spawn(process.execPath, [cli, "node", "--hostname", "127.0.0.1", "--port", String(port)], {
    cwd: path.join(__dirname, "hardhat"),
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  let output = "";
  child.stdout.on("data", (chunk) => { output += chunk; });
  child.stderr.on("data", (chunk) => { output += chunk; });

  const startedAt = Date.now();
  while (Date.now() - startedAt < 15_000) {
    if (child.exitCode !== null) throw new Error(`Hardhat node exited early:\n${output}`);
    try {
      const response = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_chainId", params: [] }),
      });
      if (response.ok) {
        return {
          url,
          async stop() {
            if (child.exitCode !== null) return;
            child.kill();
            await new Promise((resolve) => {
              child.once("exit", resolve);
              setTimeout(resolve, 2_000).unref();
            });
          },
        };
      }
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  child.kill();
  throw new Error(`Hardhat node did not start:\n${output}`);
}

module.exports = { startHardhatNode };
