"use strict";

const ERC20_ABI = [
  "function balanceOf(address) view returns (uint256)",
  "function allowance(address,address) view returns (uint256)",
  "function approve(address,uint256) returns (bool)",
  "function decimals() view returns (uint8)",
];
const REMITTANCE_ABI = [
  "function getEstimatedOutput(address fromToken,address toToken,uint256 amountIn) view returns (uint256 amountOut,uint256 fee)",
  "function swapAndRemit(address fromToken,address toToken,uint256 amountIn,uint256 minAmountOut,uint256 deadline,address recipient) returns (uint256 amountOut)",
  "function usdcToken() view returns (address)",
  "function eurcToken() view returns (address)",
  "function eurcToUsdcRate() view returns (uint256)",
  "function feeBasisPoints() view returns (uint256)",
  "function rateUpdatedAt() view returns (uint256)",
  "function maxRateAge() view returns (uint256)",
  "function paused() view returns (bool)",
];
const QUOTE_TTL_SECONDS = 300;
const SLIPPAGE_BPS = 50n;
const BPS_DENOMINATOR = 10_000n;
const state = { config: null, provider: null, signer: null, address: null, remittance: null, quote: null, busy: false };
let quoteRequestId = 0;
const $ = (id) => document.getElementById(id);
function usesDex() { return state.config?.liquiditySource === "uniswap-v3"; }
function spender() { return usesDex() ? ArcDex.MAINNET.router : state.config.remittanceAddress; }
function configured() { return usesDex() || state.config?.remittanceConfigured; }

function setStatus(message, error = false) {
  const element = $("status");
  element.textContent = message;
  element.className = `status show${error ? " error" : ""}`;
}

function markStep(id, status) {
  const element = $(`step-${id}`);
  element.classList.toggle("active", status === "active");
  element.classList.toggle("done", status === "done");
}

async function api(path) {
  const response = await fetch(path, { headers: { Accept: "application/json" } });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || `Request failed (${response.status})`);
  return data;
}

function chainHex() { return `0x${state.config.chainId.toString(16)}`; }

async function ensureNetwork() {
  const current = await window.ethereum.request({ method: "eth_chainId" });
  if (Number(current) === state.config.chainId) return;
  try {
    await window.ethereum.request({ method: "wallet_switchEthereumChain", params: [{ chainId: chainHex() }] });
  } catch (error) {
    if (error.code !== 4902) throw error;
    await window.ethereum.request({
      method: "wallet_addEthereumChain",
      params: [{
        chainId: chainHex(),
        chainName: state.config.name,
        rpcUrls: [state.config.rpcUrl],
        nativeCurrency: { name: "USDC", symbol: "USDC", decimals: 18 },
        blockExplorerUrls: [state.config.explorerUrl],
      }],
    });
  }
}

async function connect() {
  if (!window.ethereum) throw new Error("Install an EVM wallet such as MetaMask or Rabby to continue.");
  if (!configured()) throw new Error("The testnet remittance contract address has not been configured.");
  await ensureNetwork();
  const provider = new ethers.BrowserProvider(window.ethereum, state.config.chainId);
  const signer = await provider.getSigner();
  const address = await signer.getAddress();
  if (usesDex()) {
    const router = await ArcDex.validate(provider, state.config);
    state.provider = provider;
    state.signer = signer;
    state.address = address;
    state.remittance = router.connect(signer);
    if (!$("recipient").value) $("recipient").value = address;
    markStep("connect", "done");
    await Promise.all([refreshBalance(), refreshQuote()]);
    if (!state.quote) setStatus("Connected to Arc Mainnet. Enter an amount to quote the existing Uniswap pool.");
    return;
  }
  const code = await provider.getCode(state.config.remittanceAddress);
  if (code === "0x") throw new Error("The configured remittance address is not a contract on this network.");
  const remittance = new ethers.Contract(state.config.remittanceAddress, REMITTANCE_ABI, signer);
  const [contractUsdc, contractEurc, paused] = await Promise.all([
    remittance.usdcToken(),
    remittance.eurcToken(),
    remittance.paused(),
  ]);
  if (contractUsdc.toLowerCase() !== state.config.usdc.toLowerCase() || contractEurc.toLowerCase() !== state.config.eurc.toLowerCase()) {
    throw new Error("The configured contract uses different token addresses from this network.");
  }
  if (paused) throw new Error("The ArcFXRemittance contract is currently paused.");
  state.provider = provider;
  state.signer = signer;
  state.address = address;
  state.remittance = remittance;
  if (!$("recipient").value) $("recipient").value = address;
  markStep("connect", "done");
  await Promise.all([refreshBalance(), refreshQuote()]);
  renderAction();
  setStatus(`Connected ${address.slice(0, 8)}…${address.slice(-6)} on ${state.config.name}.`);
}

function tokenAddress(currency) { return currency === "USDC" ? state.config.usdc : state.config.eurc; }

async function tokenInfo(currency) {
  const token = new ethers.Contract(tokenAddress(currency), ERC20_ABI, state.provider);
  const decimals = Number(await token.decimals());
  return { token, decimals };
}

async function refreshBalance() {
  if (!state.provider || !state.address) return;
  const currency = $("fromCurrency").value;
  const { token, decimals } = await tokenInfo(currency);
  const balance = await token.balanceOf(state.address);
  $("balance").textContent = `${Number(ethers.formatUnits(balance, decimals)).toLocaleString(undefined, { maximumFractionDigits: 6 })} ${currency}`;
}

function resetQuote(invalidatePending = true) {
  if (invalidatePending) quoteRequestId += 1;
  state.quote = null;
  $("receiveAmount").value = "";
  $("rate").textContent = "—";
  $("fee").textContent = "—";
  $("quoteExpiry").textContent = "Enter an amount for an on-chain quote";
  ["quote", "approve", "swap"].forEach((id) => markStep(id, ""));
  renderAction();
}

async function refreshQuote() {
  if (state.pendingHash) return;
  const requestId = ++quoteRequestId;
  resetQuote(false);
  if (!state.remittance) return;
  const amount = $("amount").value.trim();
  if (!amount) return;
  if (!/^\d+(\.\d{1,6})?$/.test(amount) || Number(amount) <= 0) {
    throw new Error("Enter an amount greater than zero with no more than 6 decimal places.");
  }
  const recipient = $("recipient").value.trim();
  if (!recipient) {
    $("quoteExpiry").textContent = "Enter a recipient wallet address";
    return;
  }
  if (!ethers.isAddress(recipient)) throw new Error("Enter a valid recipient wallet address.");

  const fromCurrency = $("fromCurrency").value;
  const toCurrency = fromCurrency === "USDC" ? "EURC" : "USDC";
  const [{ decimals: fromDecimals }, { decimals: toDecimals }] = await Promise.all([tokenInfo(fromCurrency), tokenInfo(toCurrency)]);
  const amountIn = ethers.parseUnits(amount, fromDecimals);
  markStep("quote", "active");
  if (usesDex()) {
    const result = await ArcDex.quote(state.provider, state.config, tokenAddress(fromCurrency), tokenAddress(toCurrency), amountIn);
    if (requestId !== quoteRequestId || $("amount").value.trim() !== amount ||
        $("recipient").value.trim() !== recipient || $("fromCurrency").value !== fromCurrency) return;
    state.quote = { ...result, amountIn, fromCurrency, toCurrency, fromDecimals, toDecimals, recipient };
    $("receiveAmount").value = ethers.formatUnits(result.amountOut, toDecimals);
    $("rate").textContent = `1 ${fromCurrency} ≈ ${(Number(ethers.formatUnits(result.amountOut, toDecimals)) / Number(amount)).toFixed(6)} ${toCurrency}`;
    $("fee").textContent = `0.05% pool fee (included), plus network gas`;
    $("quoteExpiry").textContent = `Minimum: ${ethers.formatUnits(result.minAmountOut, toDecimals)} ${toCurrency} · 0.5% slippage`;
    markStep("quote", "done");
    setStatus("Uniswap quote ready. The output will be sent directly to the recipient.");
    renderAction();
    return;
  }
  const [[amountOut, fee], rate, feeBps, rateUpdatedAt, maxRateAge, paused, poolBalance, latestBlock] = await Promise.all([
    state.remittance.getEstimatedOutput(tokenAddress(fromCurrency), tokenAddress(toCurrency), amountIn),
    state.remittance.eurcToUsdcRate(),
    state.remittance.feeBasisPoints(),
    state.remittance.rateUpdatedAt(),
    state.remittance.maxRateAge(),
    state.remittance.paused(),
    new ethers.Contract(tokenAddress(toCurrency), ERC20_ABI, state.provider).balanceOf(state.config.remittanceAddress),
    state.provider.getBlock("latest"),
  ]);
  if (
    requestId !== quoteRequestId ||
    $("amount").value.trim() !== amount ||
    $("recipient").value.trim() !== recipient ||
    $("fromCurrency").value !== fromCurrency
  ) return;
  if (paused) throw new Error("The ArcFXRemittance contract is currently paused.");
  if (poolBalance < amountOut) throw new Error(`Insufficient ${toCurrency} liquidity for this transfer.`);
  const chainTime = Number(latestBlock.timestamp);
  const deadline = Math.min(chainTime + QUOTE_TTL_SECONDS, Number(rateUpdatedAt + maxRateAge));
  state.quote = {
    amountIn,
    amountOut,
    minAmountOut: amountOut * (BPS_DENOMINATOR - SLIPPAGE_BPS) / BPS_DENOMINATOR,
    deadline,
    fromCurrency,
    toCurrency,
    fromDecimals,
    toDecimals,
    amountText: amount,
    recipient,
    rateUpdatedAt,
    maxRateAge,
  };
  $("receiveAmount").value = ethers.formatUnits(amountOut, toDecimals);
  $("rate").textContent = `1 EURC = ${Number(ethers.formatUnits(rate, 18)).toLocaleString(undefined, { maximumFractionDigits: 6 })} USDC`;
  $("fee").textContent = `${ethers.formatUnits(fee, fromDecimals)} ${fromCurrency} (${Number(feeBps) / 100}%)`;
  $("quoteExpiry").textContent = `Valid until ${new Date(deadline * 1000).toLocaleTimeString()}`;
  markStep("quote", "done");
  setStatus("On-chain quote ready. Review the amount and recipient before continuing.");
  renderAction();
}

async function approveAndSwap() {
  const quote = state.quote;
  const recipient = $("recipient").value.trim();
  if (!quote) throw new Error("Request a fresh on-chain quote first.");
  if (!ethers.isAddress(recipient)) throw new Error("Enter a valid recipient wallet address.");
  const currentAmount = ethers.parseUnits($("amount").value.trim(), quote.fromDecimals);
  if (
    currentAmount !== quote.amountIn ||
    $("fromCurrency").value !== quote.fromCurrency ||
    recipient.toLowerCase() !== quote.recipient.toLowerCase()
  ) {
    resetQuote();
    throw new Error("The transfer details changed. Review the fresh quote before continuing.");
  }
  const latestBlock = await state.provider.getBlock("latest");
  if (Number(latestBlock.timestamp) > quote.deadline) {
    await refreshQuote();
    throw new Error("The quote expired. A fresh quote is now displayed.");
  }
  await ensureNetwork();
  if (usesDex()) ArcDex.calls(state.config, quote); // Validate recipient before token approval.
  const { token } = await tokenInfo(quote.fromCurrency);
  const [allowance, balance] = await Promise.all([
    token.allowance(state.address, spender()),
    token.balanceOf(state.address),
  ]);
  if (balance < quote.amountIn) throw new Error(`Insufficient ${quote.fromCurrency} balance.`);
  if (allowance < quote.amountIn) {
    markStep("approve", "active");
    setStatus(`Approve ${quote.fromCurrency} spending in your wallet.`);
    const approval = await token.connect(state.signer).approve(spender(), quote.amountIn);
    setStatus(`Approval submitted: ${approval.hash}`);
    await approval.wait(1);
    markStep("approve", "done");
  } else {
    markStep("approve", "done");
  }

  markStep("swap", "active");
  setStatus("Confirm the on-chain swap and remittance in your wallet.");
  // Re-check after approval, which may take long enough for the quote to expire.
  if (Number((await state.provider.getBlock("latest")).timestamp) > quote.deadline) {
    resetQuote();
    throw new Error("Quote expired during approval. Refresh the quote before sending.");
  }
  let transaction;
  if (usesDex()) {
    const calls = ArcDex.calls(state.config, quote);
    const swap = state.remittance["multicall(uint256,bytes[])"];
    await swap.staticCall(quote.deadline, calls);
    const gas = await swap.estimateGas(quote.deadline, calls);
    const gasLimit = gas * 120n / 100n;
    const feeData = await state.provider.getFeeData();
    const gasPrice = feeData.maxFeePerGas ?? feeData.gasPrice;
    if (!gasPrice) throw new Error("Unable to estimate network fees. Retry shortly.");
    const nativeBalance = await state.provider.getBalance(state.address);
    const inputNative = quote.fromCurrency === "USDC" ? quote.amountIn * 1000000000000n : 0n;
    if (nativeBalance < inputNative + gasLimit * gasPrice) throw new Error("Keep enough USDC in your wallet for network gas.");
    transaction = await swap(quote.deadline, calls, { gasLimit });
  } else transaction = await state.remittance.swapAndRemit(
    tokenAddress(quote.fromCurrency),
    tokenAddress(quote.toCurrency),
    quote.amountIn,
    quote.minAmountOut,
    quote.deadline,
    recipient,
  );
  state.pendingHash = transaction.hash;
  state.quote = null;
  quoteRequestId += 1;
  renderAction();
  setStatus(`Transaction submitted: ${transaction.hash}`);
  try {
    await transaction.wait(1);
  } catch (error) {
    // A transport failure does not prove the transaction failed. Keep sending locked.
    setStatus(`Confirmation could not be verified. Check ${state.config.explorerUrl}/tx/${transaction.hash} before starting another transfer.`, true);
    return;
  }
  state.pendingHash = null;
  markStep("swap", "done");
  setStatus(`Remittance completed: ${state.config.explorerUrl}/tx/${transaction.hash}`);
  $("amount").value = "";
  $("receiveAmount").value = "";
  $("rate").textContent = "—";
  $("fee").textContent = "—";
  $("quoteExpiry").textContent = "Enter an amount for an on-chain quote";
  renderAction();
  await refreshBalance().catch(() => setStatus(`Remittance completed: ${state.config.explorerUrl}/tx/${transaction.hash}`));
}

function renderAction() {
  const button = $("actionBtn");
  button.disabled = state.busy || Boolean(state.pendingHash) || !state.config || !configured() || (state.address && !state.quote);
  for (const id of ["amount", "recipient", "fromCurrency", "swapBtn"]) $(id).disabled = state.busy || Boolean(state.pendingHash);
  button.textContent = !state.address ? "Connect wallet" : "Approve, swap & send";
}

async function handleAction() {
  if (state.busy) return;
  state.busy = true;
  renderAction();
  try {
    if (!state.address) await connect();
    else await approveAndSwap();
  } catch (error) {
    console.error(error);
    setStatus(error.shortMessage || error.reason || error.message || "Something went wrong.", true);
  } finally {
    state.busy = false;
    renderAction();
  }
}

async function initialize() {
  try {
    state.config = await api("/api/config");
    $("networkLabel").textContent = `${state.config.name} · ${state.config.chainId}`;
    if (!configured()) {
      setStatus("Deployment required: configure ARC_REMITTANCE_ADDRESS with a funded ArcFXRemittance contract.", true);
    }
    renderAction();
  } catch (error) {
    setStatus(error.message, true);
  }
}

$("actionBtn").addEventListener("click", handleAction);
$("swapBtn").addEventListener("click", async () => {
  $("fromCurrency").value = $("fromCurrency").value === "USDC" ? "EURC" : "USDC";
  $("toCurrency").textContent = $("fromCurrency").value === "USDC" ? "EURC" : "USDC";
  await Promise.all([refreshBalance(), refreshQuote()]).catch((error) => setStatus(error.message, true));
});
$("fromCurrency").addEventListener("change", async () => {
  $("toCurrency").textContent = $("fromCurrency").value === "USDC" ? "EURC" : "USDC";
  await Promise.all([refreshBalance(), refreshQuote()]).catch((error) => setStatus(error.message, true));
});
$("amount").addEventListener("input", () => refreshQuote().catch((error) => setStatus(error.message, true)));
$("recipient").addEventListener("input", () => {
  if (state.quote) resetQuote();
  refreshQuote().catch((error) => setStatus(error.message, true));
});
window.ethereum?.on?.("accountsChanged", () => location.reload());
window.ethereum?.on?.("chainChanged", () => location.reload());
initialize();
