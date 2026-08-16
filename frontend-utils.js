(function (root, factory) {
    const api = factory();
    if (typeof module === "object" && module.exports) module.exports = api;
    else root.ArcFXUtils = api;
})(typeof self !== "undefined" ? self : this, function () {
    "use strict";

    function minimumOutput(quote, slippageBps) {
        if (!Number.isInteger(slippageBps) || slippageBps < 0 || slippageBps >= 10_000) {
            throw new RangeError("Invalid slippage basis points");
        }
        return quote.mul(10_000 - slippageBps).div(10_000);
    }

    function errorMessage(error) {
        return error?.error?.message || error?.data?.message || error?.reason || error?.message || "Unknown error";
    }

    function shortAddress(address) {
        return `${address.slice(0, 6)}...${address.slice(-4)}`;
    }

    return { minimumOutput, errorMessage, shortAddress };
});
