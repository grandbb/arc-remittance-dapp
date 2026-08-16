# Arc Remittance DApp

Fixed-rate USDC/EURC remittance prototype for Arc Testnet.

## Security properties

- swaps include a caller-defined minimum output and five-minute UI deadline
- token transfers use optional-return-safe low-level calls
- swaps and liquidity deposits are protected against reentrancy
- fee-on-transfer inputs are rejected so pool accounting cannot be silently diluted
- the browser reports success only after an on-chain receipt succeeds
- the UI validates chain, amount, recipient, token decimals, and deployed contract configuration

The owner-controlled FX rate is a trust assumption. Production deployments should replace it with a documented oracle/governance policy and undergo an independent audit.

## Configure the UI

Deploy `ArcFXRemittance.sol`, then set `CONTRACT_ADDRESS` in `index.html`. The UI remains disabled while the address is empty so it cannot display simulated success.

## Tests

Smart-contract tests require [Foundry](https://book.getfoundry.sh/):

```sh
forge test
```

Dependency-free frontend utility tests use Node.js 20+:

```sh
node --test test/frontend-utils.test.js
```
