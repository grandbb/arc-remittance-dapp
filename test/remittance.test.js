const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { after, before, beforeEach, test } = require("node:test");
const solc = require("solc");
const { ContractFactory, JsonRpcProvider, parseUnits } = require("ethers");
const { startHardhatNode } = require("./hardhat-node");

let hardhat;
let provider;
let snapshotId;

before(async () => {
  hardhat = await startHardhatNode();
  provider = new JsonRpcProvider(hardhat.url);
  snapshotId = await provider.send("evm_snapshot", []);
});

beforeEach(async () => {
  await provider.send("evm_revert", [snapshotId]);
  snapshotId = await provider.send("evm_snapshot", []);
});

after(async () => {
  provider.destroy();
  await hardhat.stop();
});

function compile() {
  const root = path.resolve(__dirname, "..");
  const sources = Object.fromEntries(
    ["ArcFXRemittance.sol", "MockERC20.sol"].map((file) => [
      file,
      { content: fs.readFileSync(path.join(root, file), "utf8") },
    ]),
  );
  const result = JSON.parse(
    solc.compile(
      JSON.stringify({
        language: "Solidity",
        sources,
        settings: {
          evmVersion: "paris",
          outputSelection: { "*": { "*": ["abi", "evm.bytecode.object"] } },
        },
      }),
    ),
  );
  const errors = (result.errors || []).filter((entry) => entry.severity === "error");
  assert.equal(errors.length, 0, errors.map((entry) => entry.formattedMessage).join("\n"));
  return result.contracts;
}

async function deploy(artifact, signer, args = []) {
  const factory = new ContractFactory(artifact.abi, artifact.evm.bytecode.object, signer);
  const contract = await factory.deploy(...args);
  await contract.waitForDeployment();
  return contract;
}

test("quotes and executes a USDC to EURC remittance", async () => {
  const contracts = compile();
  const owner = await provider.getSigner(0);
  const sender = await provider.getSigner(1);
  const recipient = await provider.getSigner(2);
  const tokenArtifact = contracts["MockERC20.sol"].MockStablecoin;
  const remittanceArtifact = contracts["ArcFXRemittance.sol"].ArcFXRemittance;

  const usdc = await deploy(tokenArtifact, owner, ["Mock USDC", "mUSDC", 18]);
  const eurc = await deploy(tokenArtifact, owner, ["Mock EURC", "mEURC", 18]);
  const rate = parseUnits("1.08", 18);
  const remittance = await deploy(remittanceArtifact, owner, [
    await usdc.getAddress(),
    await eurc.getAddress(),
    rate,
  ]);

  const liquidity = parseUnits("10000", 18);
  await (await eurc.approve(await remittance.getAddress(), liquidity)).wait();
  await (await remittance.addLiquidity(await eurc.getAddress(), liquidity)).wait();
  await (await remittance.setPaused(false)).wait();

  const amountIn = parseUnits("100", 18);
  await (await usdc.mint(await sender.getAddress(), amountIn)).wait();
  await (await usdc.connect(sender).approve(await remittance.getAddress(), amountIn)).wait();

  const [quotedAmount, fee] = await remittance.getEstimatedOutput(
    await usdc.getAddress(),
    await eurc.getAddress(),
    amountIn,
  );
  assert.equal(fee, parseUnits("0.1", 18));

  await (
    await remittance
      .connect(sender)
      .swapAndRemit(
        await usdc.getAddress(),
        await eurc.getAddress(),
        amountIn,
        quotedAmount,
        Math.floor(Date.now() / 1000) + 300,
        await recipient.getAddress(),
      )
  ).wait();

  assert.equal(await eurc.balanceOf(await recipient.getAddress()), quotedAmount);
  assert.equal(await usdc.balanceOf(await remittance.getAddress()), amountIn);
});

test("rejects unsupported token pairs and zero recipients", async () => {
  const contracts = compile();
  const owner = await provider.getSigner(0);
  const tokenArtifact = contracts["MockERC20.sol"].MockStablecoin;
  const remittanceArtifact = contracts["ArcFXRemittance.sol"].ArcFXRemittance;
  const usdc = await deploy(tokenArtifact, owner, ["Mock USDC", "mUSDC", 18]);
  const eurc = await deploy(tokenArtifact, owner, ["Mock EURC", "mEURC", 18]);
  const other = await deploy(tokenArtifact, owner, ["Other", "OTHER", 18]);
  const remittance = await deploy(remittanceArtifact, owner, [
    await usdc.getAddress(),
    await eurc.getAddress(),
    parseUnits("1.08", 18),
  ]);
  await (await remittance.setPaused(false)).wait();

  await assert.rejects(
    remittance.getEstimatedOutput(await other.getAddress(), await eurc.getAddress(), 1n),
    /Unsupported token pair/,
  );
  await assert.rejects(
    remittance.swapAndRemit(
      await usdc.getAddress(),
      await eurc.getAddress(),
      1n,
      0n,
      Math.floor(Date.now() / 1000) + 300,
      "0x0000000000000000000000000000000000000000",
    ),
  );
});

test("rejects expired quotes and excessive slippage", async () => {
  const contracts = compile();
  const owner = await provider.getSigner(0);
  const sender = await provider.getSigner(1);
  const tokenArtifact = contracts["MockERC20.sol"].MockStablecoin;
  const remittanceArtifact = contracts["ArcFXRemittance.sol"].ArcFXRemittance;
  const usdc = await deploy(tokenArtifact, owner, ["Mock USDC", "mUSDC", 18]);
  const eurc = await deploy(tokenArtifact, owner, ["Mock EURC", "mEURC", 18]);
  const remittance = await deploy(remittanceArtifact, owner, [
    await usdc.getAddress(),
    await eurc.getAddress(),
    parseUnits("1.08", 18),
  ]);
  await (await remittance.setPaused(false)).wait();
  const amountIn = parseUnits("10", 18);
  await (await usdc.mint(await sender.getAddress(), amountIn)).wait();
  await (await usdc.connect(sender).approve(await remittance.getAddress(), amountIn)).wait();
  const [quotedAmount] = await remittance.getEstimatedOutput(await usdc.getAddress(), await eurc.getAddress(), amountIn);

  await assert.rejects(
    remittance.connect(sender).swapAndRemit(
      await usdc.getAddress(), await eurc.getAddress(), amountIn, quotedAmount, 1, await sender.getAddress(),
    ),
  );
  await assert.rejects(
    remittance.connect(sender).swapAndRemit(
      await usdc.getAddress(), await eurc.getAddress(), amountIn, quotedAmount + 1n,
      Math.floor(Date.now() / 1000) + 300, await sender.getAddress(),
    ),
  );
});

test("rejects stale rates, paused swaps, and zero-output transfers", async () => {
  const contracts = compile();
  const owner = await provider.getSigner(0);
  const sender = await provider.getSigner(1);
  const tokenArtifact = contracts["MockERC20.sol"].MockStablecoin;
  const remittanceArtifact = contracts["ArcFXRemittance.sol"].ArcFXRemittance;
  const usdc = await deploy(tokenArtifact, owner, ["Mock USDC", "mUSDC", 6]);
  const eurc = await deploy(tokenArtifact, owner, ["Mock EURC", "mEURC", 6]);
  const remittance = await deploy(remittanceArtifact, owner, [
    await usdc.getAddress(),
    await eurc.getAddress(),
    parseUnits("1.08", 18),
  ]);

  assert.equal(await remittance.paused(), true);
  await (await remittance.setPaused(false)).wait();
  await assert.rejects(
    remittance.getEstimatedOutput(await usdc.getAddress(), await eurc.getAddress(), 1n),
  );
  await (await remittance.setPaused(true)).wait();
  await assert.rejects(
    remittance.getEstimatedOutput(await usdc.getAddress(), await eurc.getAddress(), parseUnits("1", 6)),
  );
  await (await remittance.setPaused(false)).wait();
  await provider.send("evm_increaseTime", [3601]);
  await provider.send("evm_mine", []);
  await assert.rejects(
    remittance.getEstimatedOutput(await usdc.getAddress(), await eurc.getAddress(), parseUnits("1", 6)),
  );
  await (await remittance.setEurcToUsdcRate(parseUnits("1.07", 18))).wait();
  const [freshOutput] = await remittance.getEstimatedOutput(
    await usdc.getAddress(),
    await eurc.getAddress(),
    parseUnits("1", 6),
  );
  assert(freshOutput > 0n);

});

test("only the owner manages liquidity and ownership transfers require acceptance", async () => {
  const contracts = compile();
  const owner = await provider.getSigner(0);
  const other = await provider.getSigner(1);
  const tokenArtifact = contracts["MockERC20.sol"].MockStablecoin;
  const remittanceArtifact = contracts["ArcFXRemittance.sol"].ArcFXRemittance;
  const usdc = await deploy(tokenArtifact, owner, ["Mock USDC", "mUSDC", 6]);
  const eurc = await deploy(tokenArtifact, owner, ["Mock EURC", "mEURC", 6]);
  const remittance = await deploy(remittanceArtifact, owner, [
    await usdc.getAddress(),
    await eurc.getAddress(),
    parseUnits("1.08", 18),
  ]);
  const amount = parseUnits("100", 6);
  await (await usdc.approve(await remittance.getAddress(), amount)).wait();
  await (await remittance.addLiquidity(await usdc.getAddress(), amount)).wait();
  await (await remittance.setPaused(false)).wait();
  await assert.rejects(remittance.withdrawLiquidity(await usdc.getAddress(), await owner.getAddress(), amount));
  await assert.rejects(remittance.connect(other).withdrawLiquidity(await usdc.getAddress(), await other.getAddress(), amount));

  await (await remittance.transferOwnership(await other.getAddress())).wait();
  assert.equal(await remittance.owner(), await owner.getAddress());
  await (await remittance.connect(other).acceptOwnership()).wait();
  assert.equal(await remittance.owner(), await other.getAddress());
  await (await remittance.connect(other).setPaused(true)).wait();
  await (await remittance.connect(other).withdrawLiquidity(
    await usdc.getAddress(),
    await other.getAddress(),
    amount,
    { gasLimit: 500_000 },
  )).wait();
  assert.equal(await usdc.balanceOf(await other.getAddress()), amount);

});

