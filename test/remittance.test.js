const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const ganache = require("ganache");
const solc = require("solc");
const { BrowserProvider, ContractFactory, parseUnits } = require("ethers");

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
  const provider = new BrowserProvider(ganache.provider({ logging: { quiet: true } }));
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
      .swapAndRemit(await usdc.getAddress(), await eurc.getAddress(), amountIn, await recipient.getAddress())
  ).wait();

  assert.equal(await eurc.balanceOf(await recipient.getAddress()), quotedAmount);
  assert.equal(await usdc.balanceOf(await remittance.getAddress()), amountIn);
});

test("rejects unsupported token pairs and zero recipients", async () => {
  const contracts = compile();
  const provider = new BrowserProvider(ganache.provider({ logging: { quiet: true } }));
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

  await assert.rejects(
    remittance.getEstimatedOutput(await other.getAddress(), await eurc.getAddress(), 1n),
    /Unsupported token pair/,
  );
  await assert.rejects(
    remittance.swapAndRemit(await usdc.getAddress(), await eurc.getAddress(), 1n, "0x0000000000000000000000000000000000000000"),
  );
});

