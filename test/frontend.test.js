const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");
const realEthers = require("ethers");

function createElement() {
  return {
    value: "",
    textContent: "",
    className: "",
    disabled: false,
    classList: { toggle() {} },
    addEventListener() {},
  };
}

test("an older quote response cannot replace the current amount", async () => {
  const elements = new Map();
  const pending = [];
  const document = {
    getElementById(id) {
      if (!elements.has(id)) elements.set(id, createElement());
      return elements.get(id);
    },
  };
  class MockContract {
    async balanceOf() { return 10_000_000_000n; }
  }
  const context = vm.createContext({
    console,
    document,
    window: {},
    fetch: async () => ({ ok: true, json: async () => ({}) }),
    ethers: { ...realEthers, Contract: MockContract },
  });
  const source = fs.readFileSync(path.join(__dirname, "..", "app.js"), "utf8").replace(/initialize\(\);\s*$/, "");
  vm.runInContext(source, context);
  vm.runInContext(`
    state.config = {
      remittanceConfigured: true,
      remittanceAddress: "0x4444444444444444444444444444444444444444",
      usdc: "0x1111111111111111111111111111111111111111",
      eurc: "0x2222222222222222222222222222222222222222"
    };
    state.address = "0x3333333333333333333333333333333333333333";
    state.provider = { getBlock: async () => ({ timestamp: 100 }) };
    tokenInfo = async () => ({ decimals: 6 });
    state.remittance = {
      getEstimatedOutput: (_a, _b, amount) => new Promise((resolve) => pending.push({ amount, resolve })),
      eurcToUsdcRate: async () => 1080000000000000000n,
      feeBasisPoints: async () => 10n,
      rateUpdatedAt: async () => 1n,
      maxRateAge: async () => 3600n,
      paused: async () => false
    };
    $("fromCurrency").value = "USDC";
    $("recipient").value = "0x3333333333333333333333333333333333333333";
  `, context);
  context.pending = pending;

  vm.runInContext('$("amount").value = "100"; globalThis.firstQuote = refreshQuote();', context);
  while (pending.length < 1) await Promise.resolve();
  vm.runInContext('$("amount").value = "1"; globalThis.secondQuote = refreshQuote();', context);
  while (pending.length < 2) await Promise.resolve();
  pending[1].resolve([925_000n, 1_000n]);
  await context.secondQuote;
  pending[0].resolve([92_500_000n, 100_000n]);
  await context.firstQuote;

  assert.equal(vm.runInContext('$("amount").value', context), "1");
  assert.equal(vm.runInContext("state.quote.amountIn", context), 1_000_000n);
  assert.equal(vm.runInContext('$("actionBtn").disabled', context), false);
});
