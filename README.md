# ArcFX Remittance

ArcFX is an open-source prototype for direct USDC/EURC remittances on Arc Testnet. A sender deposits one supported stablecoin, the contract applies a 0.1% protocol fee and transfers the quoted output token directly to the recipient.

> Prototype status: this project has not been audited. Use testnet assets only.

## What is included

- `ArcFXRemittance.sol` — two-token liquidity pool, quote calculation and direct-to-recipient settlement.
- `MockERC20.sol` — mintable test token for local development.
- `index.html` — wallet-enabled interface prototype.
- `test/remittance.test.js` — local end-to-end contract tests using Ganache.

## Run locally

Requirements: Node.js 20 or newer.

```bash
npm install
npm test
npm run compile
```

Open `index.html` with a static web server to inspect the interface:

```bash
npx serve .
```

The interface does not claim an onchain settlement until a deployed contract address is configured. Contract tests are the authoritative executable demonstration in the current prototype.

## Contract flow

1. A liquidity provider approves and calls `addLiquidity` with USDC or EURC.
2. A sender calls `getEstimatedOutput` to obtain the deterministic quote.
3. The sender approves the input token.
4. The sender calls `swapAndRemit`; the output token is transferred directly to the recipient.

The initial FX rate uses 18-decimal fixed-point precision. For example, `1.08e18` means 1 EURC equals 1.08 USDC.

## Security model and limitations

- The owner controls the quoted FX rate; the prototype does not use an oracle.
- Liquidity accounting is pooled and does not issue LP shares.
- There is no production withdrawal or fee-distribution mechanism yet.
- The contracts have not undergone an independent security audit.
- The frontend is a prototype and must be configured with deployed addresses before it can submit transactions.

These limitations are intentionally documented so contributors can review and improve them.

## Roadmap

- Integrate an auditable FX oracle and rate-staleness checks.
- Add LP share accounting, withdrawals and fee distribution.
- Add deployed Arc Testnet addresses and verified explorer links.
- Connect the web interface to contract quote, approval and remittance calls.
- Add fuzz tests and an independent security review.

## Contributing

Issues and pull requests are welcome. Please include a test for contract behavior changes and never commit private keys or funded wallet credentials.

## License

MIT

