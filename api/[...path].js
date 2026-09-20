"use strict";

const { createHandler, getRuntimeConfig } = require("../server");

module.exports = createHandler({ config: getRuntimeConfig() });
