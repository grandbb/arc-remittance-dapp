"use strict";

const ERC20_ABI = [
  "function balanceOf(address) view returns (uint256)",
  "function allowance(address,address) view returns (uint256)",
  "function approve(address,uint256) returns (bool)",
  "function decimals() view returns (uint8)",
];
const TERMINAL = new Set(["completed", "failed", "refunded", "breached"]);
const state = { config: null, provider: null, signer: null, address: null, quote: null, trade: null, tradeKey: null, busy: false };
const $ = (id) => document.getElementById(id);

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

function api(path, options = {}) {
  return fetch(path, {
    ...options,
    headers: { "Content-Type": "application/json", ...(options.headers || {}) },
  }).then(async (response) => {
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.error || `Request failed (${response.status})`);
    return data;
  });
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
      params: [{ chainId: chainHex(), chainName: state.config.name, rpcUrls: [state.config.rpcUrl], nativeCurrency: { name: "USDC", symbol: "USDC", decimals: 18 }, blockExplorerUrls: [state.config.explorerUrl] }],
    });
  }
}

async function connect() {
  if (!window.ethereum) throw new Error("กรุณาติดตั้ง wallet ที่รองรับ EVM เช่น MetaMask หรือ Rabby");
  await ensureNetwork();
  state.provider = new ethers.BrowserProvider(window.ethereum, state.config.chainId);
  state.signer = await state.provider.getSigner();
  state.address = await state.signer.getAddress();
  if (!$("recipient").value) $("recipient").value = state.address;
  markStep("connect", "done");
  await refreshBalance();
  renderAction();
  setStatus(`เชื่อมต่อ ${state.address.slice(0, 8)}…${state.address.slice(-6)} บน ${state.config.name} แล้ว`);
}

function tokenAddress(currency) { return currency === "USDC" ? state.config.usdc : state.config.eurc; }

async function refreshBalance() {
  if (!state.signer) return;
  const currency = $("fromCurrency").value;
  const token = new ethers.Contract(tokenAddress(currency), ERC20_ABI, state.provider);
  const [balance, decimals] = await Promise.all([token.balanceOf(state.address), token.decimals()]);
  $("balance").textContent = `${Number(ethers.formatUnits(balance, decimals)).toLocaleString(undefined, { maximumFractionDigits: 6 })} ${currency}`;
}

function resetQuote() {
  state.quote = null;
  state.trade = null;
  state.tradeKey = null;
  $("receiveAmount").value = "";
  $("rate").textContent = "—";
  $("fee").textContent = "—";
  $("quoteExpiry").textContent = "ขอราคาจริงก่อนดำเนินการ";
  ["quote", "sign", "fund", "settle"].forEach((id) => markStep(id, ""));
  renderAction();
}

function cleanTypes(types) { return Object.fromEntries(Object.entries(types).filter(([name]) => name !== "EIP712Domain")); }

function assertTypedData(typedData, expectedToken, expectedRecipient) {
  if (!typedData?.domain || !typedData?.types || !typedData?.message) throw new Error("Circle ส่งข้อมูลลายเซ็นไม่ครบ");
  if (Number(typedData.domain.chainId) !== state.config.chainId) throw new Error("Quote นี้อยู่คนละ Arc network");
  if (String(typedData.domain.verifyingContract).toLowerCase() !== state.config.permit2.toLowerCase()) throw new Error("Quote ใช้ Permit2 contract ที่ไม่ตรงกับค่าทางการ");
  const permittedToken = typedData.message?.permitted?.token;
  if (permittedToken && permittedToken.toLowerCase() !== expectedToken.toLowerCase()) throw new Error("Token ใน quote ไม่ตรงกับสินทรัพย์ที่เลือก");
  const recipient = typedData.message?.witness?.recipient;
  if (expectedRecipient && recipient && recipient.toLowerCase() !== expectedRecipient.toLowerCase()) throw new Error("ผู้รับใน quote ไม่ตรงกับที่ระบุ");
}

async function requestQuote() {
  const amount = $("amount").value.trim();
  const recipient = $("recipient").value.trim();
  if (!/^\d+(\.\d{1,6})?$/.test(amount) || Number(amount) <= 0) throw new Error("กรอกจำนวนที่มากกว่า 0 และทศนิยมไม่เกิน 6 ตำแหน่ง");
  if (!ethers.isAddress(recipient)) throw new Error("Wallet ผู้รับไม่ถูกต้อง");
  const fromCurrency = $("fromCurrency").value;
  const toCurrency = fromCurrency === "USDC" ? "EURC" : "USDC";
  markStep("quote", "active");
  const quote = await api("/api/stablefx/quotes", { method: "POST", body: JSON.stringify({ from: { currency: fromCurrency, amount }, to: { currency: toCurrency }, recipientAddress: recipient }) });
  assertTypedData(quote.typedData, tokenAddress(fromCurrency), recipient);
  state.quote = quote;
  $("receiveAmount").value = quote.to?.amount || "";
  $("rate").textContent = quote.rate ? `1 ${fromCurrency} = ${quote.rate} ${toCurrency}` : "รวมอยู่ใน quote";
  $("fee").textContent = quote.fee ? `${quote.fee.amount} ${quote.fee.currency}` : "แสดงใน settlement";
  $("quoteExpiry").textContent = quote.expiresAt ? `หมดอายุ ${new Date(quote.expiresAt).toLocaleTimeString()}` : "ราคาพร้อมใช้งาน";
  markStep("quote", "done");
  renderAction();
}

async function ensureAllowance() {
  const currency = $("fromCurrency").value;
  const token = new ethers.Contract(tokenAddress(currency), ERC20_ABI, state.signer);
  const required = BigInt(state.quote.typedData.message.permitted.amount);
  const allowance = await token.allowance(state.address, state.config.permit2);
  if (allowance >= required) return;
  setStatus(`กำลังอนุมัติ ${currency} ให้ Permit2…`);
  const feeData = await state.provider.getFeeData();
  const floor = ethers.parseUnits("20", "gwei");
  const priority = feeData.maxPriorityFeePerGas ?? ethers.parseUnits("1", "gwei");
  const suggested = feeData.maxFeePerGas ?? floor + priority;
  const maxFeePerGas = suggested > floor + priority ? suggested : floor + priority;
  const transaction = await token.approve(state.config.permit2, required, { maxFeePerGas, maxPriorityFeePerGas: priority });
  setStatus(`ส่งธุรกรรมอนุมัติแล้ว: ${transaction.hash}`);
  await transaction.wait(1);
}

async function signAndFund() {
  const quote = state.quote;
  if (quote.expiresAt && Date.now() >= new Date(quote.expiresAt).getTime()) { resetQuote(); throw new Error("Quote หมดอายุแล้ว กรุณาขอราคาใหม่"); }
  await ensureNetwork();
  markStep("sign", "active");
  await ensureAllowance();
  const q = quote.typedData;
  const signature = await state.signer.signTypedData(q.domain, cleanTypes(q.types), q.message);
  state.tradeKey ||= crypto.randomUUID();
  const trade = await api("/api/stablefx/trades", { method: "POST", body: JSON.stringify({ idempotencyKey: state.tradeKey, quoteId: quote.id, address: state.address, message: q.message, signature }) });
  state.trade = trade;
  markStep("sign", "done");
  markStep("fund", "active");
  const presign = await api("/api/stablefx/funding/presign", { method: "POST", body: JSON.stringify({ contractTradeId: trade.contractTradeId }) });
  assertTypedData(presign.typedData, tokenAddress($("fromCurrency").value));
  const funding = presign.typedData;
  const fundingSignature = await state.signer.signTypedData(funding.domain, cleanTypes(funding.types), funding.message);
  await api("/api/stablefx/fund", { method: "POST", body: JSON.stringify({ signature: fundingSignature, permit2: funding.message }) });
  markStep("fund", "done");
  markStep("settle", "active");
  await pollTrade(trade.id);
}

async function pollTrade(id) {
  const startedAt = Date.now();
  let trade;
  while (Date.now() - startedAt < 120_000) {
    trade = await api(`/api/stablefx/trades/${encodeURIComponent(id)}`);
    const status = trade.status || "processing";
    setStatus(`StableFX trade ${id}: ${status}`);
    if (TERMINAL.has(status)) break;
    await new Promise((resolve) => setTimeout(resolve, 2000));
  }
  if (trade?.status === "completed") {
    markStep("settle", "done");
    const hash = trade.settlementTransactionHash;
    setStatus(hash ? `Settlement สำเร็จ: ${state.config.explorerUrl}/tx/${hash}` : "Settlement สำเร็จบน Arc");
  } else if (trade && TERMINAL.has(trade.status)) throw new Error(`StableFX trade สิ้นสุดด้วยสถานะ ${trade.status}`);
  else setStatus(`Trade ${id} ยังดำเนินการอยู่ สามารถตรวจสถานะต่อด้วย trade ID นี้ได้`);
}

function renderAction() {
  const button = $("actionBtn");
  button.disabled = state.busy || !state.config;
  button.textContent = !state.address ? "เชื่อมต่อ Wallet" : !state.quote ? "ขอราคา StableFX" : "ยืนยัน แลก และส่ง";
}

async function handleAction() {
  if (state.busy) return;
  state.busy = true;
  renderAction();
  try {
    if (!state.address) await connect();
    else if (!state.quote) await requestQuote();
    else await signAndFund();
  } catch (error) {
    console.error(error);
    setStatus(error.shortMessage || error.message || "เกิดข้อผิดพลาด", true);
  } finally { state.busy = false; renderAction(); }
}

async function initialize() {
  try {
    state.config = await api("/api/config");
    $("networkLabel").textContent = `${state.config.name} · ${state.config.chainId}`;
    if (!state.config.stableFxConfigured) setStatus("Server ยังไม่ได้ตั้ง CIRCLE_API_KEY จึงเชื่อม wallet และดูยอดได้ แต่ยังขอราคาไม่ได้", true);
    renderAction();
  } catch (error) { setStatus(error.message, true); }
}

$("actionBtn").addEventListener("click", handleAction);
$("swapBtn").addEventListener("click", async () => {
  $("fromCurrency").value = $("fromCurrency").value === "USDC" ? "EURC" : "USDC";
  $("toCurrency").textContent = $("fromCurrency").value === "USDC" ? "EURC" : "USDC";
  resetQuote();
  await refreshBalance().catch((error) => setStatus(error.message, true));
});
$("fromCurrency").addEventListener("change", async () => {
  $("toCurrency").textContent = $("fromCurrency").value === "USDC" ? "EURC" : "USDC";
  resetQuote();
  await refreshBalance().catch((error) => setStatus(error.message, true));
});
for (const id of ["amount", "recipient"]) $(id).addEventListener("input", resetQuote);
window.ethereum?.on?.("accountsChanged", () => location.reload());
window.ethereum?.on?.("chainChanged", () => location.reload());
initialize();
