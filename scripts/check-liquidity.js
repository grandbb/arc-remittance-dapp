"use strict";
// Read-only: never signs or broadcasts a transaction.
const { JsonRpcProvider, Contract, formatUnits, parseUnits } = require("ethers");
const { NETWORKS } = require("../server");
const dex = require("../dex");
(async () => {
  const config = NETWORKS.mainnet;
  const provider = new JsonRpcProvider(config.rpcUrl);
  try {
    await dex.validate(provider, config);
    const block = await provider.getBlockNumber();
    const balances = {};
    for (const token of ["usdc", "eurc"]) {
      balances[token] = formatUnits(await new Contract(config[token], ["function balanceOf(address) view returns(uint256)"], provider)
        .balanceOf(dex.MAINNET.pool, { blockTag: block }), 6);
    }
    const quotes = [];
    for (const from of ["usdc", "eurc"]) {
      const to = from === "usdc" ? "eurc" : "usdc";
      const q = await dex.quote(provider, config, config[from], config[to], parseUnits("100", 6));
      quotes.push({ from, to, input: "100", output: formatUnits(q.amountOut, 6), minimum: formatUnits(q.minAmountOut, 6), block: q.blockNumber });
    }
    console.log(JSON.stringify({ checkedAt: new Date().toISOString(), chainId: config.chainId,
      pool: dex.MAINNET.pool, poolFeePercent: 0.05, balanceBlock: block, balances, quotes }, null, 2));
  } finally { provider.destroy(); }
})().catch(error => { console.error(error.shortMessage || error.message); process.exitCode = 1; });
