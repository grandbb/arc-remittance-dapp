const test = require("node:test");
const assert = require("node:assert/strict");
const { minimumOutput, errorMessage, shortAddress } = require("../frontend-utils.js");

class FakeBigNumber {
    constructor(value) { this.value = BigInt(value); }
    mul(value) { return new FakeBigNumber(this.value * BigInt(value)); }
    div(value) { return new FakeBigNumber(this.value / BigInt(value)); }
}

test("minimumOutput applies slippage using integer arithmetic", () => {
    assert.equal(minimumOutput(new FakeBigNumber(1_000_000), 50).value, 995_000n);
});

test("minimumOutput rejects unsafe slippage values", () => {
    assert.throws(() => minimumOutput(new FakeBigNumber(1), 10_000), RangeError);
    assert.throws(() => minimumOutput(new FakeBigNumber(1), -1), RangeError);
});

test("errorMessage prefers nested wallet errors", () => {
    assert.equal(errorMessage({ error: { message: "user rejected" }, message: "outer" }), "user rejected");
});

test("shortAddress keeps recognizable prefix and suffix", () => {
    assert.equal(shortAddress("0x1234567890abcdef1234567890abcdef12345678"), "0x1234...5678");
});
