const fs = require("node:fs");
const path = require("node:path");
const solc = require("solc");

const root = path.resolve(__dirname, "..");
const sources = Object.fromEntries(
  ["ArcFXRemittance.sol", "MockERC20.sol"].map((file) => [
    file,
    { content: fs.readFileSync(path.join(root, file), "utf8") },
  ]),
);

const output = JSON.parse(
  solc.compile(
    JSON.stringify({
      language: "Solidity",
      sources,
      settings: {
        evmVersion: "paris",
        optimizer: { enabled: true, runs: 200 },
        outputSelection: { "*": { "*": ["abi", "evm.bytecode.object"] } },
      },
    }),
  ),
);

const errors = (output.errors || []).filter((entry) => entry.severity === "error");
if (errors.length) {
  console.error(errors.map((entry) => entry.formattedMessage).join("\n"));
  process.exit(1);
}

const buildDir = path.join(root, "build");
fs.mkdirSync(buildDir, { recursive: true });
for (const [source, contracts] of Object.entries(output.contracts)) {
  for (const [name, artifact] of Object.entries(contracts)) {
    fs.writeFileSync(
      path.join(buildDir, `${name}.json`),
      JSON.stringify({ contractName: name, sourceName: source, ...artifact }, null, 2),
    );
  }
}

console.log(`Compiled ${Object.values(output.contracts).flatMap(Object.keys).length} contracts.`);

