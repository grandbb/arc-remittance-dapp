// Local demonstration only: no RPC credentials, wallet, or real funds.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const ganache = require("ganache");
const { BrowserProvider, ContractFactory, parseEther, formatEther } = require("ethers");

async function main() {
  execFileSync(process.execPath, [path.join(__dirname, "compile.js")], { stdio: "inherit" });
  const chain = ganache.provider({ logging: { quiet: true } });
  const provider = new BrowserProvider(chain);
  provider.pollingInterval = 50;
  try {
    const owner = await provider.getSigner(0);
    const sender = await provider.getSigner(1);
    const recipient = await provider.getSigner(2);
    async function deploy(name, args) {
      const artifact = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "build", `${name}.json`)));
      const contract = await new ContractFactory(artifact.abi, artifact.evm.bytecode.object, owner).deploy(...args);
      await contract.waitForDeployment();
      return contract;
    }
    const usdc = await deploy("MockStablecoin", ["Mock USDC", "mUSDC", 18]);
    const eurc = await deploy("MockStablecoin", ["Mock EURC", "mEURC", 18]);
    const pool = await deploy("ArcFXRemittance", [await usdc.getAddress(), await eurc.getAddress(), parseEther("1.08")]);
    const poolAddress = await pool.getAddress();
    for (const token of [usdc, eurc]) {
      await (await token.approve(poolAddress, parseEther("10000"))).wait();
      await (await pool.addLiquidity(await token.getAddress(), parseEther("10000"))).wait();
      await (await token.mint(await sender.getAddress(), parseEther("100"))).wait();
      await (await token.connect(sender).approve(poolAddress, parseEther("100"))).wait();
    }
    console.log("\nArcFX local demo | 18-decimal mock tokens | 1 EURC = 1.08 USDC");
    for (const [from, to, label] of [[usdc, eurc, "USDC -> EURC"], [eurc, usdc, "EURC -> USDC"]]) {
      const input = parseEther("100");
      const [quote, fee] = await pool.getEstimatedOutput(await from.getAddress(), await to.getAddress(), input);
      const before = await to.balanceOf(await recipient.getAddress());
      await (await pool.connect(sender).swapAndRemit(await from.getAddress(), await to.getAddress(), input, await recipient.getAddress())).wait();
      const received = (await to.balanceOf(await recipient.getAddress())) - before;
      assert.equal(received, quote, "Received amount must match the contract quote");
      console.log(`${label}: sent 100, fee ${formatEther(fee)}, recipient received ${formatEther(received)}`);
    }
    console.log("Both transfers verified on a temporary local chain. No real funds used.");
  } finally {
    provider.destroy();
    await chain.disconnect();
  }
}
main().catch(error => { console.error(error.message); process.exitCode = 1; });
