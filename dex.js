/* Shared browser/Node adapter for the verified Arc Uniswap V3 deployment. */
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory(require("ethers"));
  else root.ArcDex = factory(root.ethers);
})(typeof globalThis !== "undefined" ? globalThis : this, function (ethers) {
  "use strict";
  const MAINNET = Object.freeze({
    factory: "0xf0db7b58379503491d857db50ac9ece64c653918",
    router: "0x53bf6b0684ec7ef91e1387da3d1a1769bc5a6f77",
    quoter: "0x7dfd4f31be6814d2906bde155c3e1b146eac1468",
    pool: "0x6fd5f2fb831940dcd61a98c5b3acb7d8c6f3bfc1",
    fee: 500,
  });
  const ROUTER_ABI = [
    "function factory() view returns(address)",
    "function exactInputSingle((address tokenIn,address tokenOut,uint24 fee,address recipient,uint256 amountIn,uint256 amountOutMinimum,uint160 sqrtPriceLimitX96)) payable returns(uint256 amountOut)",
    "function multicall(uint256 deadline,bytes[] data) payable returns(bytes[] results)",
  ];
  const QUOTER_ABI = [
    "function factory() view returns(address)",
    "function quoteExactInputSingle((address tokenIn,address tokenOut,uint256 amountIn,uint24 fee,uint160 sqrtPriceLimitX96)) returns(uint256 amountOut,uint160 sqrtPriceX96After,uint32 initializedTicksCrossed,uint256 gasEstimate)",
  ];
  const POOL_ABI = [
    "function token0() view returns(address)", "function token1() view returns(address)",
    "function fee() view returns(uint24)", "function liquidity() view returns(uint128)",
  ];
  function same(a, b) { return a.toLowerCase() === b.toLowerCase(); }
  function addresses(config) {
    if (config.chainId !== 5042) throw new Error("The verified Uniswap pool is available on Arc Mainnet only.");
    return MAINNET;
  }
  async function validate(provider, config) {
    const d = addresses(config);
    if (Number((await provider.getNetwork()).chainId) !== config.chainId) throw new Error("Wrong wallet network.");
    for (const address of [d.factory, d.router, d.quoter, d.pool]) {
      if (await provider.getCode(address) === "0x") throw new Error("A required Uniswap contract is missing.");
    }
    const factory = new ethers.Contract(d.factory, ["function getPool(address,address,uint24) view returns(address)"], provider);
    const pool = new ethers.Contract(d.pool, POOL_ABI, provider);
    const [registered, rf, qf, t0, t1, fee, active] = await Promise.all([
      factory.getPool(config.usdc, config.eurc, d.fee),
      new ethers.Contract(d.router, ROUTER_ABI, provider).factory(),
      new ethers.Contract(d.quoter, QUOTER_ABI, provider).factory(),
      pool.token0(), pool.token1(), pool.fee(), pool.liquidity(),
    ]);
    if (!same(registered, d.pool) || !same(rf, d.factory) || !same(qf, d.factory) ||
        ![t0, t1].some(t => same(t, config.usdc)) || ![t0, t1].some(t => same(t, config.eurc)) || Number(fee) !== d.fee) {
      throw new Error("Uniswap deployment or token verification failed.");
    }
    if (active === 0n) throw new Error("The Uniswap pool has no active liquidity.");
    return new ethers.Contract(d.router, ROUTER_ABI, provider);
  }
  async function quote(provider, config, tokenIn, tokenOut, amountIn) {
    const d = addresses(config);
    if (amountIn <= 0n || same(tokenIn, tokenOut) ||
        ![config.usdc, config.eurc].some(t => same(t, tokenIn)) ||
        ![config.usdc, config.eurc].some(t => same(t, tokenOut))) throw new Error("Invalid swap pair or amount.");
    const block = await provider.getBlock("latest");
    const quoter = new ethers.Contract(d.quoter, QUOTER_ABI, provider);
    const result = await quoter.quoteExactInputSingle.staticCall([tokenIn, tokenOut, amountIn, d.fee, 0], { blockTag: block.number });
    if (result[0] <= 0n) throw new Error("The amount is too small or liquidity is unavailable.");
    const minimum = result[0] * 9950n / 10000n;
    if (minimum <= 0n) throw new Error("Increase the amount to obtain a positive minimum received.");
    return { amountOut: result[0], minAmountOut: minimum, deadline: block.timestamp + 300,
      fee: amountIn * BigInt(d.fee) / 1000000n, blockNumber: block.number };
  }
  function calls(config, quote) {
    const d = addresses(config);
    const iface = new ethers.Interface(ROUTER_ABI);
    if (!ethers.isAddress(quote.recipient) || same(quote.recipient, ethers.ZeroAddress) ||
        same(quote.recipient, d.router) || same(quote.recipient, d.pool) ||
        BigInt(quote.recipient) <= 2n || quote.minAmountOut <= 0n) throw new Error("Invalid recipient or minimum output.");
    return [iface.encodeFunctionData("exactInputSingle", [[
      config[quote.fromCurrency.toLowerCase()], config[quote.toCurrency.toLowerCase()],
      d.fee, quote.recipient, quote.amountIn, quote.minAmountOut, 0,
    ]])];
  }
  return { MAINNET, ROUTER_ABI, validate, quote, calls };
});
